import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { ArchiveStore } from '../src/archive.js';
import { archivePlan, applyArchive, archivePolicy } from '../src/archiving.js';
import { TaskStore, MemoryBackend } from '../src/state-store.js';
import { Runtime } from '../src/runtime.js';
import { initialState } from '../src/config.js';
import { continuationPolicy, archiveRound, ownCommentIds, roundsOf } from '../src/workflow.js';
import { validateLocalWait, dependencyEvent } from '../src/followup.js';
import { openTaskDomain, RecordDomainBackend, TASK_DOMAIN } from '../src/migration.js';
import { exportLegacyState } from '../scripts/export-legacy-state.js';
import { FakeDomain } from './fake-domain.js';

const DAY = 864e5, NOW = Date.parse('2026-11-23T00:00:00Z');
const ago = days => new Date(NOW - days * DAY).toISOString();
let seq = 0;
function task(id, extra = {}) {
  const { ended = 5, ...rest } = extra;
  return { id, key: JSON.stringify([`w/${id}`, '1']), cwd: process.cwd(), projectId: 'p', prompt: 'p', basePrompt: 'goal', goalPrompt: 'goal', title: id,
    executors: ['codex'], status: 'review', report: 'sent', owner: 'scheduler', resultContract: true, assessed: true,
    attempts: [{ id: `${id}-a`, executor: 'codex', status: 'review', accepted: true, sessionId: `${id}-s` }],
    outcome: { status: 'complete' }, summary: `${id} result`, events: [{ action: 'review', at: ago(ended) }],
    createdAt: new Date(NOW - 30 * DAY + seq++ * 1000).toISOString(), ...rest };
}
function settings() {
  const s = initialState().settings;
  s.projects = [{ id: 'p', label: 'P', cwd: process.cwd(), followup: { enabled: true, commentAuthorIds: ['peer'], maxWakeups: 8 } }];
  return s;
}
const state = (tasks, outbox = []) => ({ version: 1, revision: 0, paused: true, settings: settings(), tasks, outbox });
const ids = list => list.map(t => t.id).sort();

test('archive plan: superseded and quiet old history leave; anything automatic paths still read stays', () => {
  const s = state([
    task('superseded', { supersededBy: 'next', ended: 0 }), task('next', { continuationOf: 'superseded' }),
    task('accepted-old', { status: 'accepted', issue: { id: 'i1' } }),
    task('accepted-young', { status: 'accepted', ended: 1, issue: { id: 'i2' } }),
    task('review-old', { issue: { id: 'i3' }, ended: 30 }),
    task('stalled-old', { status: 'stalled', issue: { id: 'i4' } }),
    task('waited-on', { status: 'accepted', issue: { id: 'i5' } }),
    task('waiter', { status: 'blocked', issue: { id: 'i6' }, wait: { kind: 'task', taskId: 'waited-on', status: 'watching' } }),
    task('reporting', { status: 'stopped', issue: { id: 'i7' } }),
    task('human', { status: 'stopped', owner: 'human', issue: { id: 'i8' } }),
    // An older task of the same issue that must stay keeps its current task hot as well.
    task('older', { status: 'stopped', owner: 'human', issue: { id: 'i9' } }), task('head', { status: 'accepted', issue: { id: 'i9' } }),
    task('running', { status: 'running' })
  ], [{ id: 'o-pending', taskId: 'reporting', status: 'pending', tries: 0 }]);
  const plan = archivePlan(s, archivePolicy(s.settings), NOW);
  assert.deepEqual(ids(plan.tasks), ['accepted-old', 'superseded']);
});

test('only the latest rounds stay hot; the continuation budget and round compaction read archived ones back', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dispatch-archive-')), archive = await new ArchiveStore(dir).open();
  const item = (status, evidence) => ({ id: 'stage', title: 'Stage', status, dependsOn: [], action: status === 'ready' ? 'do' : '', evidence });
  const rounds = [];
  const full = task('long', { status: 'running' });
  for (let i = 0; i < 6; i++) archiveRound(full, { summary: `round ${i}`, outcome: { workItems: [item('ready', [`evidence ${i % 3}`])] }, at: ago(1) });
  const trimmed = structuredClone(full), s = state([trimmed]);
  const plan = archivePlan(s, { ...archivePolicy(), keepRounds: 2 }, NOW);
  await applyArchive(s, archive, plan, NOW);
  assert.equal(trimmed.rounds.length, 2); assert.equal(trimmed.archivedRounds, 4);
  Object.defineProperty(s, 'archive', { value: archive });
  assert.deepEqual(roundsOf(trimmed, s), full.rounds);
  for (const evidence of ['evidence 0', 'evidence 7']) {
    const outcome = { workItems: [item('ready', [evidence])], progress: 'p' };
    assert.deepEqual(continuationPolicy(trimmed, outcome, 40, archive.rounds('long')), continuationPolicy(full, outcome, 40));
  }
  const next = { summary: 'round 6', outcome: { workItems: [item('ready', ['evidence 1'])] }, at: ago(0) };
  archiveRound(full, structuredClone(next)); archiveRound(trimmed, structuredClone(next), archive.rounds('long'));
  assert.deepEqual(trimmed.rounds, full.rounds.slice(-3));
  // A repeated pass after a crash repeats the append; readers see every round once.
  await archive.archiveRounds('long', 0, full.rounds.slice(0, 4));
  assert.equal((await new ArchiveStore(dir).open()).rounds('long').length, 4);
});

async function runtimeWith(tasks, outbox = []) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dispatch-archive-rt-')), archive = await new ArchiveStore(dir).open();
  const backend = new MemoryBackend(state(tasks, outbox)), store = await new TaskStore(backend, { archive }).open();
  const runtime = await new Runtime({ store, directory: dir, env: { TEST_TOKEN: 'synthetic' } }).init();
  return { runtime, store, archive, backend, dir };
}

test('archived tasks keep deduplication, lineage, dependencies, own comments and sessions working', async () => {
  const f = await runtimeWith([
    task('a1', { status: 'review', supersededBy: 'a2', issue: { id: 'ia', identifier: 'EX-1' } }),
    task('a2', { status: 'accepted', continuationOf: 'a1', key: JSON.stringify(['w/a1', 'continue:a1']), issue: { id: 'ia', identifier: 'EX-1' } }),
    task('b', { status: 'blocked', issue: { id: 'ib', identifier: 'EX-2' }, outcome: { status: 'blocked' }, ended: 0 })
  ], [{ id: 'own-comment', taskId: 'a1', status: 'sent', tries: 0, finishedAt: ago(2) }]);
  const result = await f.runtime.archiveHistory(NOW);
  assert.deepEqual(result, { tasks: 2, rounds: 0, outbox: 1 });
  const s = await f.store.read();
  assert.deepEqual(s.tasks.map(t => t.id), ['b']);
  assert.equal(s.outbox.length, 0);
  // Intake of an archived round does not create the task again.
  assert.equal(await f.runtime.dispatcher.enqueue({ source: 'w/a1', round: '1', cwd: process.cwd(), prompt: 'p', executors: ['codex'] }), 'a1');
  assert.ok(ownCommentIds(s).includes('own-comment'));
  // A new task wait naming the historical id or the issue resolves through archived lineage to the chain head,
  // whose completion receipt is read back from the archive.
  for (const wait of [{ kind: 'task', condition: 'c', taskId: 'a1' }, { kind: 'task', condition: 'c', issueId: 'EX-1' }]) {
    const resolved = validateLocalWait(wait, s.tasks[0], s);
    assert.equal(resolved.taskId, 'a2');
    const event = dependencyEvent({ ...resolved, id: 'w1' }, s.tasks[0], s, NOW);
    assert.match(event.key, /^task:w1:a2:a2-a$/);
  }
  // Sessions of archived tasks are still registered.
  await f.runtime.submit({ projectId: 'p', title: 'resume', prompt: 'p', session: { executor: 'codex', id: 'a1-s' } });
  // The archive is read on demand: full task with every round, and archived ids are listed.
  const view = await f.runtime.command({ action: 'archived-task', id: 'a2' });
  assert.equal(view.summary, 'a2 result'); assert.equal(view.archived, true);
  assert.deepEqual((await f.runtime.snapshot()).archived.map(t => t.id).sort(), ['a1', 'a2']);
});

test('the same decisions are made with and without the archive', async () => {
  const make = () => [task('a1', { supersededBy: 'a2', issue: { id: 'ia', identifier: 'EX-1' } }),
    task('a2', { status: 'accepted', continuationOf: 'a1', key: JSON.stringify(['w/a1', 'continue:a1']), issue: { id: 'ia', identifier: 'EX-1' } }),
    task('b', { status: 'blocked', issue: { id: 'ib', identifier: 'EX-2' }, ended: 0 })];
  const plain = state(make()), f = await runtimeWith(make());
  await f.runtime.archiveHistory(NOW);
  const archived = await f.store.read();
  for (const wait of [{ kind: 'task', condition: 'c', taskId: 'a1' }, { kind: 'task', condition: 'c', issueId: 'EX-1' },
    { kind: 'task', condition: 'c', taskId: 'missing' }, { kind: 'task', condition: 'c', taskId: 'b' }]) {
    const outcome = s => { try { return validateLocalWait(wait, s.tasks.find(t => t.id === 'b'), s); } catch (e) { return e.code; } };
    assert.deepEqual(outcome(archived), outcome(plain), JSON.stringify(wait));
  }
});

test('a command on an archived task acts on it as before', async () => {
  const f = await runtimeWith([task('done', { status: 'accepted', issue: { id: 'id1', identifier: 'EX-3' }, workItems: [], ownerInstructions: ['keep scope'] })]);
  await f.runtime.archiveHistory(NOW);
  assert.equal((await f.store.read()).tasks.length, 0);
  await f.runtime.command({ action: 'continue', id: 'done', prompt: 'One more check.' });
  const s = await f.store.read();
  assert.deepEqual(s.tasks.map(t => t.id).length, 2);
  const next = s.tasks.find(t => t.continuationOf === 'done');
  assert.ok(next); assert.equal(s.tasks.find(t => t.id === 'done').supersededBy, next.id);
  assert.deepEqual(next.ownerInstructions, ['keep scope', 'One more check.']);
  assert.match(next.prompt, /done result/);
});

test('migration archives history first, and the rollback export restores the original document', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dispatch-archive-mig-'));
  const tasks = [];
  for (let i = 0; i < 4; i++) tasks.push(task(`c${i}`, { issue: { id: 'chain' }, ...(i < 3 ? { supersededBy: `c${i + 1}` } : { status: 'running' }),
    ...(i ? { continuationOf: `c${i - 1}` } : {}),
    rounds: Array.from({ length: 5 }, (_, k) => ({ summary: `c${i} round ${k}`, at: ago(1), compacted: true })) }));
  const legacy = state(tasks, [{ id: 'o1', taskId: 'c0', status: 'sent', tries: 0 }, { id: 'o2', taskId: 'c3', status: 'pending', tries: 0 }]);
  legacy.paused = false;
  await writeFile(path.join(root, 'agent_dispatcher.json'), JSON.stringify({ unit: { name: 'agent_dispatcher', version: 1 }, global: legacy, tables: {} }));
  const archive = await new ArchiveStore(path.join(root, 'archive')).open();
  const domains = { agent_dispatcher: new FakeDomain({ initial: legacy, tables: [] }), [TASK_DOMAIN]: new FakeDomain({ directory: path.join(root, TASK_DOMAIN) }) };
  const domain = await openTaskDomain({ open: async spec => domains[spec.name], spec: { name: TASK_DOMAIN }, legacySpec: { name: 'agent_dispatcher' },
    isFresh: v => isDeepStrictEqual(v, initialState()), backupCandidates: [root], directory: root,
    prepare: async s => applyArchive(s, archive, archivePlan(s, archivePolicy(s.settings), NOW, { unstampedOutbox: 'archive' }), NOW).then(() => s) });
  assert.deepEqual([...domain.table('tasks').keys()], ['c3']);
  assert.deepEqual([...domain.table('outbox').keys()], ['o2']);
  assert.equal(domain.table('tasks').get('c3').rounds.length, 3);
  const store = await new TaskStore(new RecordDomainBackend(domain), { archive }).open();
  const s = await store.read();
  assert.deepEqual(roundsOf(s.tasks[0], s).map(r => r.summary), tasks[3].rounds.map(r => r.summary));
  const exported = await exportLegacyState({ storage: root, archive: path.join(root, 'archive') });
  assert.deepEqual(exported, legacy);
});
