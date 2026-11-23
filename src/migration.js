import { copyFile, stat, mkdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { retrying, writeJson } from './store.js';

export const LEGACY_DOMAIN = 'agent_dispatcher';
export const TASK_DOMAIN = 'agent_dispatcher_v2';
export const MIGRATION_VERSION = 1;

/**
 * TaskStore backend over the per-record domain: one document per task and per outbox item, plus a small
 * global document (settings, flags, cursors, record order, migration marker). Writes go records first, then
 * the global document, then deletions, so an interrupted write can always be told apart on reopen: a record
 * missing from the order is either new (kept) or left behind by archiving (dropped).
 */
export class RecordDomainBackend {
  constructor(domain) { this.domain = domain; }
  async loadAll() {
    const { migration, ...global } = this.domain.global.get();
    if (!migration?.complete) throw new Error('Dispatcher state has not been migrated; refusing to start with empty state');
    this.migration = migration;
    const records = {};
    for (const table of ['tasks', 'outbox']) records[table] = new Map([...this.domain.table(table).entries()].map(([k, v]) => [k, structuredClone(v)]));
    return { global, records };
  }
  async write(batch, written) {
    for (const { table, id, text } of batch.puts) {
      await retrying(() => this.domain.table(table).put(id, JSON.parse(text)));
      written('put', table, id, text);
    }
    if (batch.global !== undefined) {
      await retrying(() => this.domain.global.set({ ...JSON.parse(batch.global), migration: this.migration }));
      written('global', null, null, batch.global);
    }
    for (const { table, id } of batch.deletes) {
      await retrying(() => this.domain.table(table).delete(id));
      written('delete', table, id);
    }
  }
}

const stamp = date => date.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

/**
 * Back up the legacy single document before migrating: a byte copy next to it (`<file>.bak-<time>`) when the
 * file can be located, otherwise the loaded value as JSON in the dispatcher's private directory.
 */
export async function backupLegacy({ value, candidates = [], directory, now = new Date() }) {
  for (const root of candidates.filter(Boolean)) {
    const file = path.join(root, `${LEGACY_DOMAIN}.json`);
    const info = await stat(file).catch(() => null);
    if (!info?.isFile()) continue;
    let backup;
    for (let n = 0; !backup; n++) {
      const name = `${file}.bak-${stamp(now)}${n ? `-${n}` : ''}`;
      try { await copyFile(file, name, constants.COPYFILE_EXCL); backup = name; }
      catch (error) { if (error.code !== 'EEXIST' || n >= 99) throw error; }
    }
    if ((await stat(backup)).size !== info.size) throw new Error(`Backup of ${file} is incomplete`);
    return backup;
  }
  const backup = path.join(directory, 'backups', `${LEGACY_DOMAIN}-${stamp(now)}.json`);
  await mkdir(path.dirname(backup), { recursive: true });
  await writeJson(backup, { unit: { name: LEGACY_DOMAIN, version: 1 }, global: value, tables: {} });
  return backup;
}

/**
 * Copy the legacy state into the per-record domain. Repeatable: records of an interrupted earlier run are
 * removed first, every record is rewritten, and the global document with the completion marker is written
 * last. The legacy domain is only read. `prepare` may move history out (archive) before records are written.
 */
export async function migrateLegacy({ domain, legacyValue, backup, prepare = state => state, now = new Date() }) {
  const source = structuredClone(legacyValue);
  const state = await prepare(source);
  const { tasks = [], outbox = [], ...globals } = state;
  for (const table of ['tasks', 'outbox']) {
    const stale = [...domain.table(table).keys()];
    if (stale.length) await retrying(() => domain.table(table).deleteMany(stale));
  }
  for (const [table, list] of [['tasks', tasks], ['outbox', outbox]]) {
    const ids = new Set();
    for (const record of list) {
      if (typeof record?.id !== 'string' || ids.has(record.id)) throw new Error(`Legacy ${table} record without a unique id; migration stopped`);
      ids.add(record.id);
      await retrying(() => domain.table(table).put(record.id, record));
    }
    if (domain.table(table).size !== list.length) throw new Error(`Migrated ${table} count does not match; migration stopped`);
  }
  const migration = { complete: true, version: MIGRATION_VERSION, from: LEGACY_DOMAIN, at: now.toISOString(), backup: backup || null,
    source: { tasks: (legacyValue.tasks || []).length, outbox: (legacyValue.outbox || []).length },
    hot: { tasks: tasks.length, outbox: outbox.length } };
  await retrying(() => domain.global.set({ ...globals, taskOrder: tasks.map(t => t.id), outboxOrder: outbox.map(i => i.id), migration }));
  return migration;
}

/**
 * Open the per-record domain, migrating from the legacy single document on first use. Any failure rejects:
 * the plugin reports it instead of continuing with an empty state, and the legacy document is never written.
 */
export async function openTaskDomain({ open, spec, legacySpec, isFresh, backupCandidates, directory, prepare, log = () => {} }) {
  const domain = await open(spec);
  try {
    if (domain.global.get().migration?.complete) return domain;
    const legacy = await open(legacySpec);
    try {
      const legacyValue = legacy.global.get();
      const fresh = isFresh(legacyValue);
      const backup = fresh ? null : await backupLegacy({ value: legacyValue, candidates: backupCandidates, directory });
      const migration = await migrateLegacy({ domain, legacyValue, backup, prepare });
      log(`migrated dispatcher state: ${JSON.stringify(migration)}`);
    } finally { await legacy.close(); }
    return domain;
  } catch (error) {
    await domain.close().catch(() => {});
    throw error;
  }
}
