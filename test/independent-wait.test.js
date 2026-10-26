import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { Runtime } from '../src/runtime.js';
import { MemoryStore } from '../src/dispatcher.js';
import { initialState } from '../src/config.js';
import { inspectOutcome } from '../src/outcome.js';
import { attention } from '../src/notifications.js';
import { reportBody } from '../src/reporting.js';
import { waitView, waitDraftFor } from '../src/ui/wait-view.js';

const approval = { id: 'transfer', title: 'Transfer attachment', status: 'decision', dependsOn: [], action: '', evidence: [],
  blocker: { kind: 'permission', owner: 'Owner', reason: 'Transfer requires approval', resumeWhen: 'Explicit approval' } };
const check = { id: 'check', title: 'Read-only verification', status: 'blocked', dependsOn: [], action: '', evidence: [],
  blocker: { kind: 'time', owner: 'Local scheduler', reason: 'Scheduled verification', resumeWhen: 'At the scheduled time' } };
const waiting = (notBefore = '2000-01-01T00:00:00Z') => ({ kind: 'time', condition: 'Read existing status only', notBefore, workItemIds: ['check'] });
const result = (extra = {}) => ({ status: 'decision', evidence: ['Existing state checked'], remaining: ['Transfer', 'Verification'],
  next: '', progress: 'Independent verification prepared', blockers: [{ owner: 'Owner', reason: 'Transfer approval', resumeWhen: 'Explicit approval' }],
  workItems: [structuredClone(approval), structuredClone(check)], wait: waiting(), ...extra });
const wrap = value => `<dispatch-result>${JSON.stringify(value)}</dispatch-result>`;
async function fixture(extraClient = {}) {
  const store = new MemoryStore(), state = initialState(); state.paused = false;
  state.settings.projects = [{ id: 'p', cwd: process.cwd(), executionInstructions: 'Read-only checks only. No transfer or production changes.',
    followup: { enabled: true, commentAuthorIds: ['peer'], maxWakeups: 4 },
    linear: { enabled: true, workspaceId: 'w', projectId: 'project', assigneeId: 'owner', tokenEnv: 'TEST_TOKEN' } }];
  await store.save(state);
  return new Runtime({ store, directory: os.tmpdir(), env: { TEST_TOKEN: 'synthetic' },
    linearFactory: () => ({ eligible: async () => ({}), report: async () => {}, ...extraClient }) }).init();
}
async function start(r, outcome = result()) {
  r.adapters.codex = { start: async () => ({ status: 'review', sessionId: 'original', summary: wrap(outcome) }) };
  const id = await r.submit({ projectId: 'p', prompt: 'Transfer only when approved; independently verify existing status', issue: { id: 'i' } });
  await r.dispatcher.tick(); await r.assess(); return id;
}

test('mixed decision permits only an explicit independent stage wait; prose dates cannot silently cancel it', () => {
  assert.equal(inspectOutcome(wrap(result())).error, null);
  for (const ids of [undefined, ['transfer'], ['missing'], ['check', 'check']]) {
    const value = result(); value.wait.workItemIds = ids;
    assert.ok(inspectOutcome(wrap(value)).error);
  }
  const dependent = result(); dependent.workItems[1].dependsOn = ['transfer'];
  assert.match(inspectOutcome(wrap(dependent)).error, /independent/);
  const wrongKind = result(); wrongKind.workItems[1].blocker.kind = 'external';
  assert.match(inspectOutcome(wrap(wrongKind)).error, /kind/);
  assert.match(inspectOutcome(wrap(result({ wait: undefined }))).error, /structured wait/);
  assert.ok(inspectOutcome(wrap(result({ workItems: undefined }))).error);
  const permissionOnly = result({ workItems: [approval], wait: undefined });
  assert.equal(inspectOutcome(wrap(permissionOnly)).error, null);
});

test('decision and timer survive restart, pause and failed reporting; one scoped wake never approves transfer', async () => {
  const r = await fixture({ report: async () => { throw Error('offline'); } });
  const id = await start(r); await r.report();
  let task = (await r.snapshot()).tasks[0];
  assert.equal(task.status, 'blocked'); assert.equal(task.outcome.status, 'decision');
  assert.equal(task.wait.status, 'watching'); assert.equal(task.workItems[0].status, 'decision');
  assert.ok(attention(await r.store.load(), { projectIds: ['p'] }).has(`${id}:decision`));
  assert.match(reportBody(task, { shareProgress: true }), /独立阶段单独监控/);
  assert.match(waitView(task, await r.snapshot()).title, /独立阶段/);
  assert.deepEqual(waitDraftFor(task).workItemIds, ['check']);
  await r.dispatcher.update(s => { s.paused = true; });
  const restarted = await new Runtime({ store: r.store, directory: os.tmpdir(), env: r.env, linearFactory: r.linearFactory }).init();
  let starts = 0;
  restarted.adapters.codex = { start: async ({ task: next, attempt }) => {
    starts++; assert.equal(attempt.sessionId, 'original'); assert.equal(attempt.resume, true);
    assert.match(next.prompt, /Independent wake scope: \["check"\]/);
    assert.match(next.prompt, /All pending decisions remain unapproved/);
    assert.match(next.prompt, /No transfer or production changes/);
    return { status: 'review', sessionId: 'original', summary: wrap(result({ wait: undefined,
      workItems: [approval, { ...check, status: 'done', blocker: undefined, evidence: ['Existing status read'] }] })) };
  } };
  await restarted.monitor(); await restarted.dispatcher.tick(); assert.equal(starts, 0);
  await restarted.dispatcher.update(s => { s.paused = false; });
  await Promise.all([restarted.monitor({ localOnly: true }), restarted.monitor({ localOnly: true })]);
  await restarted.dispatcher.tick(); await restarted.assess(); await restarted.monitor(); await restarted.dispatcher.tick();
  task = (await restarted.snapshot()).tasks[0];
  assert.equal(starts, 1); assert.equal(task.wakeups, 1);
  assert.equal(task.status, 'decision'); assert.equal(task.workItems[0].status, 'decision');
  assert.equal(task.workItems[1].status, 'done');
  assert.equal(task.wait.status, 'resolved');
});

test('failed assessment persistence leaves result intact; restart registers the independent timer without replay', async () => {
  const r = await fixture();
  r.adapters.codex = { start: async () => ({ status: 'review', sessionId: 'original', summary: wrap(result()) }) };
  await r.submit({ projectId: 'p', prompt: 'Goal', issue: { id: 'i' } }); await r.dispatcher.tick();
  const before = await r.store.load(), save = r.store.save.bind(r.store);
  r.store.save = async () => { throw Error('disk unavailable'); };
  await assert.rejects(r.assess(), /disk unavailable/); assert.deepEqual(await r.store.load(), before);
  r.store.save = save;
  const restarted = await new Runtime({ store: r.store, directory: os.tmpdir(), env: r.env, linearFactory: r.linearFactory }).init();
  await restarted.assess(); const task = (await restarted.snapshot()).tasks[0];
  assert.equal(task.wait.status, 'watching'); assert.equal(task.attempts.length, 1);
});

test('timer cannot bypass expiry, human ownership or a changed dependency before launch', async () => {
  for (const mode of ['expired', 'human', 'changed']) {
    const r = await fixture(); await start(r); let starts = 0;
    r.adapters.codex.start = async () => { starts++; throw Error('must not start'); };
    if (mode === 'expired') await r.dispatcher.update(s => { s.tasks[0].wait.expiresAt = '2001-01-01T00:00:00Z'; });
    if (mode === 'human') await r.dispatcher.update(s => { s.tasks[0].owner = 'human'; });
    await r.monitor({ localOnly: true });
    if (mode === 'changed') await r.dispatcher.update(s => { s.tasks[0].workItems[1].dependsOn = ['transfer']; });
    await r.dispatcher.tick(); assert.equal(starts, 0, mode);
    if (mode === 'changed') assert.equal((await r.snapshot()).tasks[0].wait.errorCode, 'WAIT_SCOPE_INVALID');
  }
});

test('same-session format repair requires a real wait instead of dropping an independent timed stage', async () => {
  const r = await fixture(); let calls = 0;
  r.adapters.codex = { start: async ({ task, attempt }) => {
    calls++; if (calls === 2) { assert.match(task.prompt, /formatting repair only/); assert.equal(attempt.sessionId, 'original'); }
    return { status: 'review', sessionId: 'original', summary: wrap(result(calls === 1 ? { wait: undefined } : {})) };
  } };
  await r.submit({ projectId: 'p', prompt: 'Goal' });
  await r.dispatcher.tick(); await r.assess(); await r.dispatcher.tick(); await r.assess();
  const task = (await r.snapshot()).tasks[0];
  assert.equal(calls, 2); assert.equal(task.status, 'blocked'); assert.equal(task.wait.status, 'watching');
});

test('scoped trusted reply wakes once while self replies cannot approve another stage', async () => {
  let comments = [];
  const r = await fixture({ activity: async () => ({ id: 'i', comments }) });
  const value = result(); value.workItems[1].blocker.kind = 'external';
  value.wait = { kind: 'linear', condition: 'Verify receipt only', expectedAuthorIds: ['peer'], workItemIds: ['check'] };
  await start(r, value);
  const reply = user => ({ id: user, user: { id: user }, updatedAt: new Date(Date.now() + 1000).toISOString(), body: 'Receipt available' });
  comments = [reply('owner'), reply('stranger')];
  await r.monitor(); assert.equal((await r.snapshot()).tasks[0].status, 'blocked');
  comments.push(reply('peer'));
  await Promise.all([r.monitor(), r.monitor()]);
  const task = (await r.snapshot()).tasks[0];
  assert.equal(task.status, 'queued'); assert.equal(task.wakeups, 1);
  assert.match(task.prompt, /Independent wake scope/);
  assert.equal(task.workItems[0].status, 'decision');
});

test('future independent timer and historical UI do not imply execution', async () => {
  const r = await fixture(); await start(r, result({ wait: waiting('2999-01-01T00:00:00Z') }));
  await r.monitor({ localOnly: true }); const state = await r.snapshot(), task = state.tasks[0];
  assert.equal(task.status, 'blocked'); assert.equal(task.attempts.length, 1);
  assert.match(waitView({ ...task, supersededBy: 'replacement' }, state).title, /历史记录/);
  assert.match(waitView({ ...task, status: 'stopped' }, state).title, /任务已停止/);
});
