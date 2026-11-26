// A user stop must stick (refactor 3.5). Before holds, LON-35/160/284/299 restarted themselves within minutes of a
// stop. Each test reproduces one path that used to (or could) restart a stopped task and proves it no longer does;
// where the path is real without a hold, a control shows it still works for unheld tasks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { MemoryStore } from '../src/dispatcher.js';
import { initialState } from '../src/config.js';
import { Runtime } from '../src/runtime.js';
import { AUTOMATIC, automaticBlock } from '../src/hold.js';
import { workItems } from './workflow-fixtures.js';
import { userStopCandidates, migrateUserStops } from '../src/explain.js';

const done = `<dispatch-result>${JSON.stringify({ status: 'complete', workItems: workItems('complete'), evidence: ['ok'], remaining: [], next: '', progress: 'done', blockers: [] })}</dispatch-result>`;
const later = () => new Date(Date.now() + 1000).toISOString();

async function fixture({ comments = () => [], followup = {}, issues = () => [], start } = {}) {
  const store = new MemoryStore(), state = initialState();
  state.paused = false;
  state.settings.projects = [{ id: 'p', label: 'Example', cwd: process.cwd(),
    linear: { enabled: true, tokenEnv: 'TEST_TOKEN', workspaceId: 'w', assigneeId: 'me', round: '1', reviewStateId: 'review', readyStateId: 'ready' },
    followup: { enabled: true, commentAuthorIds: ['peer', 'me'], maxWakeups: 8, reviewComments: true, ...followup } }];
  await store.save(state);
  const runtime = await new Runtime({ store, directory: os.tmpdir(), env: { TEST_TOKEN: 'synthetic' }, linearFactory: () => ({
    eligible: async () => ({}), activity: async () => ({ comments: comments() }), issues: async () => issues(), report: async () => {} }) }).init();
  const starts = [];
  runtime.adapters.codex = { start: async input => { starts.push(input); return start ? start(input) : { status: 'review', summary: done, sessionId: 'original-session' }; },
    stop: async () => ({ status: 'stopped' }) };
  await runtime.submit({ projectId: 'p', prompt: 'Work', issue: { id: 'issue', identifier: 'EX-1' }, source: 'w/issue' });
  await runtime.dispatcher.tick(); await runtime.assess();
  const id = (await runtime.snapshot()).tasks[0].id;
  return { runtime, starts, id };
}
const tasks = async runtime => (await runtime.snapshot()).tasks;

test('user stop persists a hold; explicit retry clears it and runs again', async () => {
  const { runtime, id, starts } = await fixture();
  await runtime.command({ action: 'stop', id, reason: '方向错了' });
  let [t] = await tasks(runtime);
  assert.equal(t.status, 'stopped');
  assert.deepEqual([t.hold.by, t.hold.reason], ['user', '方向错了']);
  await runtime.command({ action: 'retry', id });
  [t] = await tasks(runtime);
  assert.equal(t.hold, undefined);
  assert.equal(t.events.findLast(e => e.action === 'unhold').by, 'retry');
  await runtime.dispatcher.tick();
  assert.equal(starts.length, 2);
});

test('path: a trusted comment after the stop no longer resumes a held task; unhold restores it', async () => {
  const at = later();
  const { runtime, id } = await fixture({ comments: () => [{ id: 'c1', body: 'keep going', createdAt: at, updatedAt: at, user: { id: 'peer' } }] });
  await runtime.command({ action: 'stop', id });
  await runtime.reviewComments();
  assert.equal((await tasks(runtime)).length, 1, 'comment resumed a held task');
  await runtime.command({ action: 'unhold', id });
  runtime.reviewCheckedAt.clear();
  await runtime.reviewComments();
  const all = await tasks(runtime);
  assert.equal(all.length, 2);
  assert.match(all[1].prompt, /keep going/);
});

test('path: owner comments queued while the round ran do not resume a held task (LON-160)', async () => {
  const { runtime, id } = await fixture();
  await runtime.dispatcher.update(s => { s.tasks[0].pendingComments = [{ id: 'k1', createdAt: new Date().toISOString(), body: 'owner: 再算一次' }]; });
  await runtime.command({ action: 'stop', id });
  await runtime.reviewComments();
  assert.equal((await tasks(runtime)).length, 1);
});

test('path: a host restart interrupting an unconfirmed stop settles it as stopped, never requeued', async () => {
  let reconcileAs = 'running';
  const { runtime, id, starts } = await fixture({ start: () => ({ status: 'running', sessionId: 's1' }) });
  runtime.adapters.codex.stop = async () => ({ status: 'unknown' });
  runtime.adapters.codex.reconcile = async () => ({ status: reconcileAs, reason: 'host restarted' });
  await runtime.command({ action: 'stop', id });
  let [t] = await tasks(runtime);
  assert.equal(t.status, 'unknown'); assert.equal(t.pendingStop, 'stop'); assert.ok(t.hold);
  reconcileAs = 'interrupted';
  await runtime.dispatcher.reconcile();
  [t] = await tasks(runtime);
  assert.equal(t.status, 'stopped');
  assert.equal(t.pendingStop, undefined);
  assert.ok(t.events.some(e => e.action === 'interrupted-while-stopping'));
  await runtime.dispatcher.tick();
  assert.equal(starts.length, 1);
});

test('control: an interrupted round without a stop is still resumed in the same session', async () => {
  const { runtime, starts } = await fixture({ start: () => ({ status: 'running', sessionId: 's1' }) });
  runtime.adapters.codex.reconcile = async () => ({ status: 'interrupted' });
  await runtime.dispatcher.reconcile();
  assert.equal((await tasks(runtime))[0].status, 'queued');
  await runtime.dispatcher.tick();
  assert.equal(starts.length, 2);
});

test('path: automatic continuations (comment/data wake) are refused; an owner continue clears the hold', async () => {
  const { runtime, id } = await fixture();
  await runtime.command({ action: 'stop', id });
  await assert.rejects(runtime.command({ [AUTOMATIC]: true, action: 'continue', id, prompt: 'wake' }), /冻结/);
  assert.equal((await tasks(runtime)).length, 1);
  await runtime.command({ action: 'continue', id, prompt: 'owner: go on' });
  const all = await tasks(runtime);
  assert.equal(all.length, 2);
  assert.equal(all[0].hold, undefined);
  assert.equal(all[0].events.findLast(e => e.action === 'unhold').by, 'continue');
});

test('path: a data wake skips a held task; control wakes it', async () => {
  for (const held of [true, false]) {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'hold-ver-')), file = path.join(dir, 'v.txt');
    await writeFile(file, 'v1');
    const { runtime } = await fixture({ followup: { dataVersionFile: file } });
    await runtime.dispatcher.update(s => { const t = s.tasks[0]; t.status = 'blocked'; t.dataVersion = 'v1';
      t.outcome = { blockers: [{ owner: 'touf', reason: '数据未到位', resumeWhen: '数据补齐' }] };
      if (held) t.hold = { by: 'user', reason: 'test', at: new Date().toISOString() }; });
    await writeFile(file, 'v2');
    await runtime.dataWakes();
    assert.equal((await tasks(runtime)).length, held ? 1 : 2);
  }
});

test('path: a condition wake (time wait) does not queue a held task; control wakes it', async () => {
  for (const held of [true, false]) {
    const { runtime, id } = await fixture();
    await runtime.dispatcher.update(s => { s.tasks[0].status = 'blocked'; s.tasks[0].assessed = true; });
    await runtime.command({ action: 'arm-wait', id, wait: { kind: 'time', condition: 'timer', notBefore: new Date(Date.now() - 1000).toISOString() } });
    if (held) await runtime.dispatcher.update(s => { s.tasks[0].hold = { by: 'user', reason: 'test', at: new Date().toISOString() }; });
    await runtime.monitor({ localOnly: true });
    assert.equal((await tasks(runtime))[0].status, held ? 'blocked' : 'queued');
  }
});

test('arm-wait is an explicit owner request and clears the hold', async () => {
  const { runtime, id } = await fixture();
  await runtime.command({ action: 'stop', id });
  await runtime.command({ action: 'arm-wait', id, wait: { kind: 'time', condition: 'timer', notBefore: new Date(Date.now() + 60000).toISOString() } });
  assert.equal((await tasks(runtime))[0].hold, undefined);
});

test('path: assess never requeues a held task (format repair / fresh rescue / auto-continue)', async () => {
  const { runtime } = await fixture();
  await runtime.dispatcher.update(s => { const t = s.tasks[0]; t.status = 'review'; t.assessed = false; t.summary = 'no contract here';
    t.hold = { by: 'user', reason: 'test', at: new Date().toISOString() }; });
  await runtime.assess();
  const [t] = await tasks(runtime);
  assert.equal(t.status, 'needs_result');
  assert.ok(t.events.some(e => e.action === 'hold-blocked'));
});

test('path: output-limit retry skips a held task', async () => {
  const { runtime } = await fixture();
  await runtime.dispatcher.update(s => { const t = s.tasks[0]; t.status = 'failed'; t.attempts.at(-1).reason = 'max-tokens';
    t.hold = { by: 'user', reason: 'test', at: new Date().toISOString() }; });
  await runtime.retryOutputLimit();
  const [t] = await tasks(runtime);
  assert.equal(t.status, 'failed'); assert.equal(t.outputLimitRetried, undefined);
  await assert.rejects(runtime.retry(t.id, { automatic: true }), /冻结/);
});

test('path: tick never starts a held queued task', async () => {
  const { runtime, starts } = await fixture();
  await runtime.dispatcher.update(s => { const t = s.tasks[0]; t.status = 'queued'; t.attempts = [];
    t.hold = { by: 'user', reason: 'test', at: new Date().toISOString() }; });
  await runtime.dispatcher.tick();
  assert.equal(starts.length, 1);
});

test('path: intake of a new dispatch round skips a held issue without failing the project', async () => {
  const issue = { id: 'issue', identifier: 'EX-1', title: 'T', url: 'https://linear.app/x' };
  const { runtime, id } = await fixture({ issues: () => [issue] });
  await runtime.command({ action: 'stop', id });
  await runtime.dispatcher.update(s => { s.settings.projects[0].linear.round = '2'; });
  await runtime.intake();
  assert.equal((await tasks(runtime)).length, 1);
  await runtime.command({ action: 'unhold', id });
  await runtime.intake();
  assert.equal((await tasks(runtime)).length, 2);
});

test('upgrade: pre-hold stops get a hold only when opted in, and only once', async () => {
  const { runtime, id } = await fixture();
  await runtime.dispatcher.update(s => { const t = s.tasks[0]; t.status = 'stopped'; t.events.push({ action: 'stop', at: '2026-11-26T04:45:00.000Z' }); });
  // Default (no env): behaviour matches main, nothing is held.
  const off = await new Runtime({ store: runtime.store, directory: os.tmpdir(), env: {} }).init();
  assert.equal((await off.snapshot()).tasks[0].hold, undefined);
  assert.equal(userStopCandidates(await runtime.store.read()).length, 1, 'the candidate list is readable without migrating');
  const on = { DISPATCH_MIGRATE_USER_STOPS: '1' };
  const again = await new Runtime({ store: runtime.store, directory: os.tmpdir(), env: on }).init();
  const t = (await again.snapshot()).tasks.find(x => x.id === id);
  assert.equal(t.hold.at, '2026-11-26T04:45:00.000Z');
  // The owner unholds it; a restart (still opted in) must not hold it again.
  await again.command({ action: 'unhold', id });
  assert.equal((await again.snapshot()).tasks[0].hold, undefined);
  const third = await new Runtime({ store: runtime.store, directory: os.tmpdir(), env: on }).init();
  const t3 = (await third.snapshot()).tasks[0];
  assert.equal(t3.hold, undefined, 'unhold survives a restart');
  assert.equal(t3.events.filter(e => e.action === 'hold-migrated').length, 1);
});

test('upgrade candidates: a return or unhold after the stop is not a user stop; the day window limits it', () => {
  const task = (events, extra = {}) => ({ id: String(Math.random()), status: 'stopped', events, ...extra });
  const state = { tasks: [
    task([{ action: 'stop', at: '2026-11-25T00:00:00.000Z' }]),
    task([{ action: 'stop', at: '2026-11-25T00:00:00.000Z' }, { action: 'return', at: '2026-11-25T01:00:00.000Z' }]),
    task([{ action: 'stop', at: '2026-11-25T00:00:00.000Z' }, { action: 'unhold', at: '2026-11-25T01:00:00.000Z' }]),
    task([{ action: 'stop', at: '2026-10-01T00:00:00.000Z' }]),
  ] };
  assert.equal(userStopCandidates(state).length, 2);
  const now = Date.parse('2026-11-26T00:00:00.000Z');
  assert.equal(migrateUserStops(state, { DISPATCH_MIGRATE_USER_STOPS: '1', DISPATCH_MIGRATE_USER_STOPS_DAYS: '7' }, now), 1);
  assert.equal(state.tasks[0].hold?.by, 'user');
  assert.equal(state.tasks[3].hold, undefined);
  assert.equal(migrateUserStops(state, { DISPATCH_MIGRATE_USER_STOPS: '1' }, now), 0, 'runs once');
});

test('the guard: hold blocks every path, drain only paths that start new work', () => {
  const state = { drain: { on: true } };
  for (const p of ['start', 'intake', 'wake', 'comment', 'data', 'output-retry', 'continue']) assert.ok(automaticBlock({}, state, p), p);
  assert.equal(automaticBlock({}, state, 'requeue'), null);
  assert.equal(automaticBlock({}, {}, 'start'), null);
  assert.equal(automaticBlock({ hold: { by: 'user' } }, {}, 'requeue').code, 'TASK_HELD');
});
