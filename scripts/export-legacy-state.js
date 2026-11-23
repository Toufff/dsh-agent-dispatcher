#!/usr/bin/env node
// Rollback helper: export the per-record dispatcher state (plus its archive) back into the legacy
// single-document format (`agent_dispatcher.json`) read by dispatcher versions before the per-record store.
//
//   node scripts/export-legacy-state.js --out <file> [--storage <root>] [--archive <dir>] [--force]
//
// --storage  JSON storage root holding agent_dispatcher_v2/ (default: $DSH_HOME/storages or ~/.dsh/storages)
// --archive  dispatcher archive directory (default: $DSH_HOME/agent-dispatcher/archive); missing = no archive
// --out      file to write; never overwrites an existing file unless --force
//
// Only reads the storage and archive. Stop the DSH host before exporting so the state does not change underneath.
import { readFile, readdir, stat, writeFile, rename } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { TASK_DOMAIN, LEGACY_DOMAIN } from '../src/migration.js';
import { assemble } from '../src/state-store.js';
import { ArchiveStore } from '../src/archive.js';

async function readDocument(file) {
  const document = JSON.parse(await readFile(file, 'utf8'));
  if (typeof document?.version !== 'number' || !('record' in document)) throw new Error(`${file} is not a per-record document`);
  return document.record;
}
async function readTable(dir) {
  const records = new Map();
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    records.set(entry.name.slice(0, -5), await readDocument(path.join(dir, entry.name)));
  }
  return records;
}

/** The full state in legacy shape: hot records, archived tasks, archived rounds and outbox merged back. */
export async function exportLegacyState({ storage, archive }) {
  const unit = path.join(storage, TASK_DOMAIN);
  const { migration, ...global } = await readDocument(path.join(unit, 'global.json'));
  if (!migration?.complete) throw new Error('The per-record state was never completed; the legacy document is still current');
  const archived = archive && (await stat(archive).catch(() => null))?.isDirectory() ? await new ArchiveStore(archive).open() : null;
  const records = { tasks: await readTable(path.join(unit, 'tasks')), outbox: await readTable(path.join(unit, 'outbox')) };
  const { state } = assemble(global, records, (table, id) => archived?.has(table, id));
  const hot = new Set(state.tasks.map(t => t.id));
  let tasks = state.tasks;
  if (archived) {
    // Archived tasks rejoin where they were: archive passes are undone newest first, each task after the task
    // that preceded it when it was archived. Earlier rounds go back in front of the kept ones.
    const order = tasks.map(t => t.id);
    const loaded = new Map(tasks.map(t => [t.id, t]));
    const byId = id => { if (!loaded.has(id)) loaded.set(id, archived.task(id)); return loaded.get(id); };
    const passes = [];
    for (const stub of archived.history()) {
      if (hot.has(stub.id)) continue;
      const pass = stub.pass || stub.archivedAt;
      if (passes.at(-1)?.pass !== pass) passes.push({ pass, stubs: [] });
      passes.at(-1).stubs.push(stub);
    }
    for (const pass of passes.reverse()) for (const stub of pass.stubs) {
      let index = stub.prev === null ? 0 : order.indexOf(stub.prev) + 1;
      if (stub.prev === undefined || (stub.prev !== null && index === 0)) {
        // No recorded neighbour: fall back to creation time.
        index = order.findIndex(id => Date.parse(byId(id)?.createdAt || 0) > Date.parse(stub.createdAt || 0));
        if (index < 0) index = order.length;
      }
      order.splice(index, 0, stub.id);
    }
    tasks = order.map(byId);
    tasks = tasks.map(task => {
      const earlier = archived.rounds(task.id);
      if (!earlier.length) return task;
      const { archivedRounds, ...rest } = task;
      return { ...rest, rounds: [...earlier, ...(task.rounds || [])] };
    });
    const live = new Set(state.outbox.map(i => i.id));
    state.outbox = [...archived.outboxItems().filter(i => !live.has(i.id)).map(({ archivedAt, ...item }) => item), ...state.outbox];
  }
  const { tasks: _t, outbox, ...rest } = state;
  return { ...rest, version: 1, tasks, outbox };
}

async function main(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--force') args.force = true;
    else if (argv[i].startsWith('--')) args[argv[i].slice(2)] = argv[++i];
  }
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const storage = args.storage || path.join(home, 'storages');
  const archive = args.archive || path.join(home, 'agent-dispatcher', 'archive');
  if (!args.out) throw new Error('--out <file> is required');
  if (!args.force && await stat(args.out).catch(() => null)) throw new Error(`${args.out} exists; pass --force to replace it`);
  const value = await exportLegacyState({ storage, archive });
  const { domainSpec } = await import('../src/plugin.js');
  domainSpec.global.schema.parse(value);
  const text = `${JSON.stringify({ unit: { name: LEGACY_DOMAIN, version: 1 }, global: value, tables: {} }, null, 2)}\n`;
  const temp = `${args.out}.${process.pid}.tmp`;
  await writeFile(temp, text, { mode: 0o600 });
  await rename(temp, args.out);
  console.log(`exported ${value.tasks.length} tasks and ${value.outbox.length} outbox items to ${args.out}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exit(1); });
