import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { initialState } from './config.js';

// Windows readers/antivirus may briefly hold the destination open. Retry the
// same atomic replacement, never unlink the committed file or rerun the writer.
export async function replaceFile(source, destination, renameFile = rename, delay = ms => new Promise(resolve => setTimeout(resolve, ms))) {
  for (let tries = 0; ; tries++) {
    try { await renameFile(source, destination); return; }
    catch (error) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(error.code) || tries >= 4) throw error;
      await delay(50 * 2 ** tries);
    }
  }
}

export async function writeJson(file, data) {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  const handle = await open(temp, 'w', 0o600);
  try { await handle.writeFile(JSON.stringify(data)); await handle.sync(); }
  finally { await handle.close(); }
  await replaceFile(temp, file);
}

/** Standalone test/diagnostic store; production plugin uses DSH domain storage. */
export class FileStore {
  constructor(directory) { this.file = path.join(directory, 'dispatcher.json'); this.lockFile = `${this.file}.lock`; }
  async open() {
    await mkdir(path.dirname(this.file), { recursive: true });
    this.lock = await open(this.lockFile, 'wx', 0o600);
    await this.lock.writeFile(String(process.pid));
    return this;
  }
  async load() {
    try { return JSON.parse(await readFile(this.file, 'utf8')); }
    catch (e) { if (e.code === 'ENOENT') return initialState(); throw e; }
  }
  async save(state) { await writeJson(this.file, state); }
  async close() { if (this.lock) { await this.lock.close(); await unlink(this.lockFile); this.lock = null; } }
}

// Windows readers/antivirus may briefly hold a storage file open; retry the same durable write.
export async function retrying(write, delay = ms => new Promise(resolve => setTimeout(resolve, ms))) {
  for (let tries = 0; ; tries++) {
    try { return await write(); }
    catch (error) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(error.code) || tries >= 4) throw error;
      await delay(50 * 2 ** tries);
    }
  }
}

/**
 * TaskStore backend over the legacy single-document domain (global = the whole state). A write still
 * replaces the whole document, but only when a record or the global part actually changed.
 */
export class SingleDocumentBackend {
  constructor(domain) { this.domain = domain; }
  async loadAll() {
    const { tasks = [], outbox = [], ...globals } = this.domain.global.get();
    this.texts = { tasks: new Map(tasks.map(t => [t.id, JSON.stringify(t)])), outbox: new Map(outbox.map(i => [i.id, JSON.stringify(i)])) };
    this.global = JSON.stringify({ ...globals, taskOrder: tasks.map(t => t.id), outboxOrder: outbox.map(i => i.id) });
    return { global: JSON.parse(this.global), records: { tasks: new Map(tasks.map(t => [t.id, structuredClone(t)])), outbox: new Map(outbox.map(i => [i.id, structuredClone(i)])) } };
  }
  async write(batch, written) {
    const texts = { tasks: new Map(this.texts.tasks), outbox: new Map(this.texts.outbox) };
    for (const { table, id, text } of batch.puts) texts[table].set(id, text);
    for (const { table, id } of batch.deletes) texts[table].delete(id);
    const global = batch.global ?? this.global;
    const { taskOrder, outboxOrder, ...rest } = JSON.parse(global);
    const list = (table, order) => `[${order.filter(id => texts[table].has(id)).map(id => texts[table].get(id)).join(',')}]`;
    const document = JSON.parse(`${JSON.stringify(rest).slice(0, -1)}${Object.keys(rest).length ? ',' : ''}"tasks":${list('tasks', taskOrder)},"outbox":${list('outbox', outboxOrder)}}`);
    await retrying(() => this.domain.global.set(document));
    this.texts = texts; this.global = global;
    for (const { table, id, text } of batch.puts) written('put', table, id, text);
    if (batch.global !== undefined) written('global', null, null, batch.global);
    for (const { table, id } of batch.deletes) written('delete', table, id);
  }
}

/** Cross-process exclusion. Stale locks require explicit recovery after confirming the owner is gone. */
export async function acquireLease(directory) {
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, 'host.lock');
  let handle;
  try { handle = await open(file, 'wx', 0o600); }
  catch (e) { if (e.code === 'EEXIST') throw new Error('Dispatcher host lock exists. Stop the other host or recover its stale lock before restarting.'); throw e; }
  await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  return async () => { await handle.close(); await unlink(file); };
}
