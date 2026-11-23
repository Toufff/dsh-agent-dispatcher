import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, writeFile, readFile, readdir } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { FakeDomain } from './fake-domain.js';
import { openTaskDomain, RecordDomainBackend, TASK_DOMAIN } from '../src/migration.js';
import { TaskStore } from '../src/state-store.js';
import { Dispatcher } from '../src/dispatcher.js';
import { initialState } from '../src/config.js';
import { exportLegacyState } from '../scripts/export-legacy-state.js';

const task = (id, extra = {}) => ({ id, key: JSON.stringify(['src', id]), cwd: '/w', prompt: 'p', title: id, executors: ['codex'],
  status: 'review', attempts: [], report: 'sent', owner: 'scheduler', events: [{ action: 'review', at: '2026-11-01T00:00:00Z' }],
  createdAt: '2026-11-01T00:00:00Z', ...extra });
function legacyState() {
  const s = initialState(); s.paused = false; s.revision = 4;
  s.tasks = [task('t1'), task('t2', { rounds: [{ summary: 'r1', at: '2026-11-01T00:00:00Z' }] }), task('t3', { status: 'running' })];
  s.outbox = [{ id: 'o1', taskId: 't1', status: 'sent', tries: 0, body: 'x' }, { id: 'o2', taskId: 't3', status: 'pending', tries: 1, body: 'y' }];
  s.linearSync = { k: { cursor: '2026-11-01T00:00:00Z', comments: [] } };
  return s;
}
async function setup({ legacy = legacyState(), directory } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dispatch-migrate-'));
  await writeFile(path.join(root, 'agent_dispatcher.json'), JSON.stringify({ unit: { name: 'agent_dispatcher', version: 1 }, global: legacy, tables: {} }));
  const domains = { agent_dispatcher: new FakeDomain({ initial: legacy, tables: [] }),
    [TASK_DOMAIN]: new FakeDomain({ initial: {}, directory: directory ? path.join(root, TASK_DOMAIN) : undefined }) };
  const opened = [];
  const open = async spec => { opened.push(spec.name); domains[spec.name].closed = false; return domains[spec.name]; };
  const run = () => openTaskDomain({ open, spec: { name: TASK_DOMAIN }, legacySpec: { name: 'agent_dispatcher' },
    isFresh: value => isDeepStrictEqual(value, initialState()), backupCandidates: [undefined, root], directory: root });
  return { root, domains, opened, run, legacy };
}

test('first start backs up the legacy document and migrates every record in order', async () => {
  const f = await setup(), original = structuredClone(f.legacy);
  const domain = await f.run();
  const files = await readdir(f.root);
  const backup = files.find(name => /^agent_dispatcher\.json\.bak-\d{8}T\d{6}Z(-\d+)?$/.test(name));
  assert.ok(backup, files.join(','));
  assert.equal(await readFile(path.join(f.root, backup), 'utf8'), await readFile(path.join(f.root, 'agent_dispatcher.json'), 'utf8'));
  assert.equal(domain.global.get().migration.complete, true);
  assert.equal(domain.global.get().migration.backup, path.join(f.root, backup));
  assert.ok(f.domains.agent_dispatcher.closed, 'the legacy domain is closed after migrating');
  assert.deepEqual(f.legacy, original, 'the legacy value is never modified');
  const store = await new TaskStore(new RecordDomainBackend(domain)).open();
  assert.deepEqual(await store.load(), original);
  // Already migrated: the legacy domain is not opened again.
  f.opened.length = 0;
  await f.run();
  assert.deepEqual(f.opened, [TASK_DOMAIN]);
});

test('a fresh install starts from the initial state without a backup', async () => {
  const f = await setup({ legacy: initialState() });
  const domain = await f.run();
  assert.equal(domain.global.get().migration.backup, null);
  assert.equal((await readdir(f.root)).filter(n => n.includes('.bak-')).length, 0);
  const store = await new TaskStore(new RecordDomainBackend(domain)).open();
  assert.deepEqual(await store.load(), initialState());
});

test('an interrupted migration fails loudly, keeps the legacy data and can simply be run again', async () => {
  const f = await setup(), original = structuredClone(f.legacy), domain = f.domains[TASK_DOMAIN];
  domain.failOn = what => what === 'put:tasks:t3';
  await assert.rejects(f.run(), /disk unavailable/);
  assert.equal(domain.global.get().migration, undefined, 'no completion marker after a failure');
  assert.ok(domain.closed, 'the half-written domain is closed, the plugin does not continue');
  await assert.rejects(new TaskStore(new RecordDomainBackend(domain)).open(), /not been migrated/);
  // A record that the legacy state no longer has (left by the failed run) is removed by the rerun.
  await domain.table('tasks').put('stale', task('stale'));
  domain.failOn = null;
  await f.run();
  assert.deepEqual([...domain.table('tasks').keys()].sort(), ['t1', 't2', 't3']);
  const store = await new TaskStore(new RecordDomainBackend(domain)).open();
  assert.deepEqual(await store.load(), original);
  assert.deepEqual(f.legacy, original);
  assert.equal((await readdir(f.root)).filter(n => n.includes('.bak-')).length, 2, 'each attempt keeps its own backup');
});

test('the per-record backend writes only changed records and keeps the migration marker', async () => {
  const f = await setup(), domain = await f.run();
  const store = await new TaskStore(new RecordDomainBackend(domain)).open();
  const dispatcher = new Dispatcher({ store, adapters: {} });
  const puts = domain.puts;
  await dispatcher.update(s => { s.tasks[1].report = 'pending'; });
  assert.equal(domain.puts - puts, 1);
  assert.equal(domain.table('tasks').get('t2').report, 'pending');
  await dispatcher.update(s => { s.paused = true; });
  assert.equal(domain.global.get().paused, true);
  assert.equal(domain.global.get().migration.complete, true);
});

test('the rollback export reproduces the legacy document from the per-record files', async () => {
  const f = await setup({ directory: true }), domain = await f.run();
  const store = await new TaskStore(new RecordDomainBackend(domain)).open();
  await new Dispatcher({ store, adapters: {} }).update(s => { s.tasks[0].status = 'accepted'; s.revision++; });
  const exported = await exportLegacyState({ storage: f.root, archive: path.join(f.root, 'no-archive') });
  const expected = legacyState(); expected.tasks[0].status = 'accepted'; expected.revision++;
  assert.deepEqual(exported, expected);
});
