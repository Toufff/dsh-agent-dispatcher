import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { initialState } from './config.js';

export async function writeJson(file, data) {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  const handle = await open(temp, 'w', 0o600);
  try { await handle.writeFile(JSON.stringify(data)); await handle.sync(); }
  finally { await handle.close(); }
  await rename(temp, file);
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

export class DomainStore {
  constructor(domain) { this.domain = domain; }
  async load() { return structuredClone(this.domain.global.get()); }
  async save(state) { await this.domain.global.set(structuredClone(state)); }
}
