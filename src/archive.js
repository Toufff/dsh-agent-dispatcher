import { mkdir, open, readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { writeJson } from './store.js';

/**
 * Append-only history outside the hot state, in the dispatcher's private directory:
 *
 *   tasks/<id>.json        full task at the time it left the hot state
 *   index.jsonl            one stub per archived task (lineage, issue, sessions) - kept in memory
 *   rounds/<taskId>.jsonl  automatic-round results older than the latest few, by sequence number
 *   work-items/<taskId>.jsonl  completed workItems folded out of the hot ledger (src/work-items.js)
 *   outbox.jsonl           finished Linear write-backs (their ids stay known as this host's own comments)
 *
 * Nothing is ever deleted or rewritten in place. Every append is fsynced before the hot state drops the
 * data, so a crash at worst repeats an append; readers deduplicate (last line per id/sequence wins).
 */
export class ArchiveStore {
  constructor(directory) { this.directory = directory; this.cache = new Map(); }
  async open() {
    await mkdir(path.join(this.directory, 'tasks'), { recursive: true });
    await mkdir(path.join(this.directory, 'rounds'), { recursive: true });
    await mkdir(path.join(this.directory, 'work-items'), { recursive: true });
    const stubs = await this.lines('index.jsonl');
    this.index = new Map(stubs.map(stub => [stub.id, stub]));
    this.log = stubs.filter((stub, i) => stubs.findLastIndex(s => s.id === stub.id) === i);
    this.keys = new Map([...this.index.values()].filter(s => s.key).map(s => [s.key, s.id]));
    this.outbox = new Map((await this.lines('outbox.jsonl')).map(item => [item.id, item]));
    return this;
  }
  async lines(name) {
    const text = await readFile(path.join(this.directory, name), 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
    return parseLines(text);
  }
  async append(name, values) {
    if (!values.length) return;
    const file = path.join(this.directory, name);
    await mkdir(path.dirname(file), { recursive: true });
    const handle = await open(file, 'a', 0o600);
    try { await handle.writeFile(values.map(v => `${JSON.stringify(v)}\n`).join('')); await handle.sync(); }
    finally { await handle.close(); }
  }

  has(table, id) { return table === 'outbox' ? this.outbox.has(id) : this.index.has(id); }
  stub(id) { return this.index.get(id); }
  /** Id of the archived task with this dedup key. */
  idForKey(key) { return this.keys.get(key); }
  stubs() { return [...this.index.values()]; }
  /** Latest stub of every archived task, in the order they were archived. */
  history() { return [...this.log]; }
  taskIds() { return [...this.index.keys()]; }
  outboxItems() { return [...this.outbox.values()]; }
  outboxIds() { return this.outbox.keys(); }

  /** Full archived task, read on demand (synchronously: lineage checks run inside the state lock). */
  task(id) {
    if (!this.index.has(id) || !/^[\w-]+$/.test(id)) return undefined;
    return structuredClone(this.cached(`task:${id}`, () => JSON.parse(readFileSync(path.join(this.directory, 'tasks', `${id}.json`), 'utf8'))));
  }
  /** Archived rounds of a task in order (empty when none). */
  rounds(taskId) {
    if (!/^[\w-]+$/.test(taskId)) return [];
    return this.cached(`rounds:${taskId}`, () => {
      let text = '';
      try { text = readFileSync(path.join(this.directory, 'rounds', `${taskId}.jsonl`), 'utf8'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      const bySeq = new Map(parseLines(text).map(line => [line.seq, line.round]));
      return [...bySeq.keys()].sort((a, b) => a - b).map(seq => bySeq.get(seq));
    });
  }
  cached(key, load) {
    if (this.cache.has(key)) { const value = this.cache.get(key); this.cache.delete(key); this.cache.set(key, value); return value; }
    const value = load();
    this.cache.set(key, value);
    while (this.cache.size > 8) this.cache.delete(this.cache.keys().next().value);
    return value;
  }

  /** prev: id of the task right before each one in the state's order (restores the exact order on export). */
  async archiveTasks(tasks, at = new Date().toISOString(), prev = new Map()) {
    for (const task of tasks) await writeJson(path.join(this.directory, 'tasks', `${task.id}.json`), task);
    const pass = randomUUID();
    const stubs = tasks.map(task => ({ ...taskStub(task, at), prev: prev.get(task.id) ?? null, pass }));
    await this.append('index.jsonl', stubs);
    this.log = [...this.log.filter(old => !stubs.some(s => s.id === old.id)), ...stubs];
    for (const stub of stubs) { this.index.set(stub.id, stub); if (stub.key) this.keys.set(stub.key, stub.id); this.cache.delete(`task:${stub.id}`); }
  }
  /** rounds[i] gets sequence number first + i. */
  async archiveRounds(taskId, first, rounds) {
    await this.append(path.join('rounds', `${taskId}.jsonl`), rounds.map((round, i) => ({ seq: first + i, round })));
    this.cache.delete(`rounds:${taskId}`);
  }
  /** Completed workItems folded out of a task's hot ledger, appended per task (never rewritten). */
  async archiveWorkItems(taskId, items, at = new Date().toISOString()) {
    if (!/^[\w-]+$/.test(taskId || '')) throw new Error(`Task id ${JSON.stringify(taskId)} cannot be archived`);
    await this.append(path.join('work-items', `${taskId}.jsonl`), items.map(item => ({ ...item, archivedAt: at })));
    this.cache.delete(`work-items:${taskId}`);
  }
  /** Folded workItems of a task, oldest first (last line per id wins, so a repeated append is harmless). */
  workItems(taskId) {
    if (!/^[\w-]+$/.test(taskId || '')) return [];
    return this.cached(`work-items:${taskId}`, () => {
      let text = '';
      try { text = readFileSync(path.join(this.directory, 'work-items', `${taskId}.jsonl`), 'utf8'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      const byId = new Map(parseLines(text).filter(line => line?.id).map(line => [line.id, line]));
      return [...byId.values()];
    });
  }
  async archiveOutbox(items, at = new Date().toISOString()) {
    const lines = items.map(item => ({ ...item, archivedAt: at }));
    await this.append('outbox.jsonl', lines);
    for (const item of lines) this.outbox.set(item.id, item);
  }
}

function parseLines(text) {
  const values = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { values.push(JSON.parse(line)); } catch { /* a torn last line of an interrupted append */ }
  }
  return values;
}

/** What lineage, key de-duplication, session registration and history listings need without the full task. */
export function taskStub(task, archivedAt) {
  const sessions = [...(task.attempts || []), ...(task.previousAttempts || [])].filter(a => a.sessionId).map(a => [a.executor, a.sessionId]);
  return { stub: true, id: task.id, key: task.key, projectId: task.projectId, title: task.title, status: task.status, owner: task.owner, cwd: task.cwd,
    ...(task.issue ? { issue: { id: task.issue.id, identifier: task.issue.identifier, url: task.issue.url } } : {}),
    createdAt: task.createdAt, endedAt: task.events?.at(-1)?.at || task.createdAt,
    ...(task.continuationOf ? { continuationOf: task.continuationOf } : {}), ...(task.supersededBy ? { supersededBy: task.supersededBy } : {}),
    sessions: [...new Map(sessions.map(s => [s.join('\u0000'), s])).values()], archivedAt };
}
