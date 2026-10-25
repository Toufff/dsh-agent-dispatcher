import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { Runtime } from '../src/runtime.js';
import { MemoryStore } from '../src/dispatcher.js';
import { initialState } from '../src/config.js';
import { inspectOutcome } from '../src/outcome.js';
import { attention } from '../src/notifications.js';
import { waitView } from '../src/ui/wait-view.js';
import { continuationPolicy } from '../src/workflow.js';

const done = id => ({ id, title: id, status: 'done', dependsOn: [], action: '', evidence: ['isolated verification'] });
const ready = (id, dependsOn = []) => ({ id, title: id, status: 'ready', dependsOn, action: `Verify ${id} locally`, evidence: [] });
const blocked = id => ({ id, title: id, status: 'blocked', dependsOn: [], action: '', evidence: [], blocker: { kind: 'external', owner: 'Reviewer', reason: 'receipt missing', resumeWhen: 'verified receipt arrives' } });
const envelope = (status, items, extra = {}) => `<dispatch-result>${JSON.stringify({ status, workItems: items,
  evidence: ['checked'], remaining: status === 'complete' ? [] : ['remaining stages'], next: status === 'continue' ? 'Perform the ready local stage' : '',
  progress: JSON.stringify(items) || "verified", blockers: ['blocked', 'decision'].includes(status) ? [{ owner: 'Reviewer', reason: 'receipt missing', resumeWhen: 'receipt arrives' }] : [], ...extra })}</dispatch-result>`;
async function fixture(client = {}) {
  const store = new MemoryStore(), s = initialState(); s.paused = false;
  s.settings.projects = [{ id: 'p', cwd: process.cwd(), executionInstructions: 'Local work only; no deployment.',
    followup: { enabled: true, commentAuthorIds: ['peer'], maxWakeups: 1 },
    linear: { enabled: true, workspaceId: 'w', projectId: 'project', assigneeId: 'owner', tokenEnv: 'TEST_TOKEN', reviewStateId: 'review' } }];
  await store.save(s);
  return new Runtime({ store, directory: os.tmpdir(), env: { TEST_TOKEN: 'synthetic' },
    linearFactory: () => ({ eligible: async () => ({}), report: async () => {}, ...client }) }).init();
}

test('ledger rejects partial completion, lost stages, ready-work blocking and dependency cycles', () => {
  const items = [done('code'), ready('tests', ['code']), blocked('receipt')];
  assert.match(inspectOutcome(envelope('blocked', items)).error, /ready/);
  assert.match(inspectOutcome(envelope('complete', items)).error, /ready/);
  assert.equal(inspectOutcome(envelope('continue', items)).error, null);
  assert.match(inspectOutcome(envelope('complete', [done('code')]), { previous: items }).error, /drop/);
  assert.match(inspectOutcome(envelope('continue', [ready('a', ['b']), ready('b', ['a'])])).error, /cycles/);
  assert.match(inspectOutcome(envelope('complete', [{ ...done('code'), evidence: [] }])).error, /evidence/);
  assert.match(inspectOutcome(envelope('blocked', [blocked('deploy')]), { previous: [done('deploy')] }).error, /replay/);
});

test('new tasks require a stage ledger; legacy parsing remains compatible without replay', async () => {
  const r = await fixture();
  const raw = envelope('complete', undefined);
  assert.equal(inspectOutcome(raw).outcome.status, 'complete');
  let starts = 0;
  r.adapters.codex = { start: async ({ task }) => { if (++starts === 2) assert.match(task.prompt, /do not execute tools/);
    return { status: 'review', sessionId: 'same', summary: raw }; } };
  await r.submit({ projectId: 'p', prompt: 'Goal' });
  for (let i = 0; i < 3; i++) { await r.dispatcher.tick(); await r.assess(); }
  assert.equal(starts, 2); assert.equal((await r.snapshot()).tasks[0].status, 'needs_result');
  assert.match((await r.snapshot()).tasks[0].attention.reason, /阶段清单/);
});

test('mixed work repairs an erroneous whole-task block, runs local stage then waits and completes once', async () => {
  let starts = 0, comments = [];
  const r = await fixture({ activity: async () => ({ parentState: { type: 'started' }, comments }) });
  const items = [done('code'), ready('tests', ['code']), blocked('receipt')];
  const waitingItems = [done('code'), { ...done('tests'), dependsOn: ['code'] }, blocked('receipt')];
  const adapter = { start: async ({ task, attempt }) => {
    starts++; if (starts > 1) { assert.equal(attempt.sessionId, 'original'); assert.ok(attempt.resume); }
    assert.match(task.prompt, /no deployment/);
    if (starts === 2) assert.match(task.prompt, /formatting repair only/);
    if (starts === 3) assert.match(task.prompt, /"id":"tests"/);
    return { status: 'review', sessionId: 'original', summary: starts === 1 ? envelope('blocked', items)
      : starts === 2 ? envelope('continue', items)
      : starts === 3 ? envelope('blocked', waitingItems, { wait: { kind: 'linear', expectedAuthorIds: ['peer'], condition: 'receipt' } })
      : envelope('complete', [done('code'), { ...done('tests'), dependsOn: ['code'] }, done('receipt')]) };
  } };
  r.adapters.codex = adapter;
  await r.submit({ projectId: 'p', prompt: 'Code, tests and receipt', issue: { id: 'issue' } });
  for (let i = 0; i < 3; i++) { await r.dispatcher.tick(); await r.assess(); }
  assert.equal((await r.snapshot()).tasks[0].status, 'blocked');
  const restarted = await new Runtime({ store: r.store, directory: os.tmpdir(), env: r.env, linearFactory: r.linearFactory }).init();
  restarted.adapters.codex = adapter;
  comments = [{ id: 'reply', user: { id: 'peer' }, updatedAt: new Date(Date.now() + 1000).toISOString(), body: 'Receipt' }];
  await Promise.all([restarted.monitor(), restarted.monitor()]);
  await restarted.dispatcher.tick(); await restarted.assess(); await restarted.monitor(); await restarted.dispatcher.tick();
  const t = (await restarted.snapshot()).tasks[0];
  assert.equal(starts, 4); assert.equal(t.status, 'review'); assert.equal(t.workItems.length, 3);
  assert.equal(t.wakeups, 1); assert.ok(t.workItems.every(i => i.status === 'done'));
});

test('continuation is atomic, bounded, carries exact owner input and forbids stale report/rearm', async () => {
  let starts = 0; const reports = [];
  const r = await fixture({ report: async item => reports.push(item.taskId) });
  r.adapters.codex = { start: async () => ({ status: 'review', sessionId: 'original', summary: envelope('blocked', [blocked('goal')], { progress: `attempt ${++starts}` }) }) };
  await r.submit({ projectId: 'p', prompt: 'Original goal', source: 'w/i', issue: { id: 'i' } });
  await r.dispatcher.tick(); await r.assess();
  let previous = (await r.snapshot()).tasks[0]; const original = previous.id;
  for (let i = 0; i < 5; i++) {
    await r.command({ action: 'continue', id: previous.id, prompt: `Current instruction ${i}` });
    const next = (await r.snapshot()).tasks.at(-1);
    assert.match(next.prompt, new RegExp(`Current instruction ${i}`));
    for (let earlier = 0; earlier < i; earlier++) assert.match(next.prompt, new RegExp(`Current instruction ${earlier}`));
    assert.ok(next.prompt.length < 14000); assert.equal(next.goalPrompt, 'Original goal');
    assert.equal(next.session.id, 'original'); assert.equal(next.workItems[0].id, 'goal');
    await r.dispatcher.tick(); await r.assess(); previous = (await r.snapshot()).tasks.at(-1);
  }
  await r.report(); assert.deepEqual(reports, [previous.id]);
  await assert.rejects(r.command({ action: 'accept', id: original }), /superseded/);
  await assert.rejects(r.command({ action: 'arm-wait', id: original, wait: { kind: 'time', condition: 'time', notBefore: '2099-01-01T00:00:00Z' } }), /superseded/);
  await r.monitor(); assert.equal(starts, 6);
  assert.ok((await r.snapshot()).tasks.slice(0, -1).every(t => t.historical));
});

test('failed continuation persistence leaves the original round intact; restart retires old pending reports', async () => {
  const r = await fixture({ report: async () => { throw Error('offline'); } });
  r.adapters.codex = { start: async () => ({ status: 'review', sessionId: 's', summary: envelope('blocked', [blocked('goal')]) }) };
  await r.submit({ projectId: 'p', prompt: 'Goal', issue: { id: 'i' } }); await r.dispatcher.tick(); await r.assess(); await r.report();
  const before = await r.store.load(), save = r.store.save.bind(r.store), id = before.tasks[0].id;
  r.store.save = async () => { throw Error('disk unavailable'); };
  await assert.rejects(r.command({ action: 'continue', id, prompt: 'Finish authorized work' }), /disk unavailable/);
  assert.deepEqual(await r.store.load(), before);
  r.store.save = save;
  await r.command({ action: 'continue', id, prompt: 'Finish authorized work' });
  const restarted = await new Runtime({ store: r.store, directory: os.tmpdir(), env: r.env, linearFactory: r.linearFactory }).init();
  await restarted.report();
  const s = await restarted.snapshot(); assert.equal(s.tasks.length, 2);
  assert.ok(s.outbox.filter(i => i.taskId === id).every(i => i.status === 'superseded'));
});

test('same-issue intake cannot compete with queued work; explicit continuation preserves expired constraints', async () => {
  const r = await fixture();
  const id = await r.submit({ projectId: 'p', prompt: 'Goal', issue: { id: 'i' } });
  await assert.rejects(r.submit({ projectId: 'p', prompt: 'Duplicate', issue: { id: 'i' } }), /active/);
  r.adapters.codex = { start: async () => ({ status: 'review', sessionId: 's', summary: envelope('blocked', [blocked('goal')]) }) };
  await r.dispatcher.tick(); await r.assess();
  await r.dispatcher.update(s => { s.tasks[0].resumeWindow = { expiresAt: '2000-01-01T00:00:00Z' }; });
  await r.command({ action: 'continue', id, prompt: 'Do not extend the expired window' });
  let starts = 0; r.adapters.codex.start = async () => { starts++; throw Error('must not start'); };
  await r.dispatcher.tick();
  const t = (await r.snapshot()).tasks.at(-1); assert.equal(t.status, 'blocked'); assert.equal(starts, 0);
  await r.command({ action: 'arm-wait', id: t.id, wait: { kind: 'time', condition: 'new explicit local interval', notBefore: '2099-01-01T00:00:00Z' } });
  const rearmed = (await r.snapshot()).tasks.at(-1);
  assert.equal(rearmed.wait.status, 'watching'); assert.equal(rearmed.session.id, 's');
  assert.ok(rearmed.summary.includes('dispatch-result')); assert.equal(starts, 0);
});

test('in-flight old reporting finishes before continuation is published; no late old retry', async () => {
  let release, started;
  const entered = new Promise(resolve => { started = resolve; });
  const r = await fixture({ report: async () => { started(); await new Promise(resolve => { release = resolve; }); } });
  r.adapters.codex = { start: async () => ({ status: 'review', sessionId: 'same', summary: envelope('complete', [done('goal')]) }) };
  await r.submit({ projectId: 'p', prompt: 'Goal', issue: { id: 'i' } }); await r.dispatcher.tick(); await r.assess();
  const id = (await r.snapshot()).tasks[0].id;
  const report = r.report(); await entered;
  const continuation = r.command({ action: 'continue', id, prompt: 'Inspect a new independently authorized requirement' });
  await new Promise(resolve => setImmediate(resolve)); assert.equal((await r.snapshot()).tasks.length, 1);
  release(); await report; await continuation;
  const s = await r.snapshot(); assert.equal(s.tasks.length, 2); assert.equal(s.tasks[0].report, 'superseded');
});

test('blocked without a trigger, limits and missing progress have actionable local notifications', async () => {
  const r = await fixture(); let n = 0;
  r.adapters.codex = { start: async () => ({ status: 'review', sessionId: 's', summary: envelope('continue', [ready('goal')], { progress: `step ${++n}` }) }) };
  await r.submit({ projectId: 'p', prompt: 'Goal' });
  for (let i = 0; i < 4; i++) { await r.dispatcher.tick(); await r.assess(); }
  let s = await r.snapshot(); assert.equal(s.tasks[0].continuationStop, 'budget');
  assert.match(s.tasks[0].attention.reason, /预算/); assert.equal(s.tasks[0].attention.owner, '本地负责人');
  assert.equal(attention(s, { projectIds: ['p'] }).size, 1);
  await r.dispatcher.update(state => { state.tasks[0].status = 'blocked'; delete state.tasks[0].wait; });
  s = await r.snapshot(); assert.match(s.tasks[0].attention.reason, /恢复条件/);
  assert.equal([...attention(s, { projectIds: ['p'] }).values()][0].type, 'unrouted');
});

test('expired dates never conceal stopped, superseded or budget-limited monitoring', () => {
  const s = initialState(); s.settings.projects = [{ id: 'p', followup: { enabled: true, observeAfterExpiry: true } }];
  const task = { id: 't', projectId: 'p', status: 'blocked', wait: { kind: 'time', status: 'limit', expiresAt: '2000-01-01T00:00:00Z' } };
  s.tasks = [task];
  assert.equal(waitView(task, s).title, '自动唤醒次数已用完');
  assert.equal(waitView({ ...task, historical: true }, s).monitor, '不再监听或回写');
  assert.equal(waitView({ ...task, wait: { ...task.wait, status: 'suspended' } }, s).monitor, '监听已停止');
});

test('disabled historical test projects retain local detail without polluting business alerts', async () => {
  const r = await fixture();
  await r.dispatcher.update(s => {
    s.settings.projects.push({ id: 'old-test', category: 'test', cwd: process.cwd() });
    s.tasks.push({ id: 'old-test-task', projectId: 'old-test', title: 'Archived synthetic test', status: 'needs_result', attempts: [], events: [] });
  });
  const s = await r.snapshot();
  assert.ok(s.tasks[0].attention); assert.equal(s.errors.length, 0);
});

test('checkpoint progress crosses three rounds, survives restart and ends at the actual goal', async () => {
  let starts = 0;
  let r = await fixture();
  const adapter = { start: async ({ attempt }) => {
    const n = ++starts;
    if (n > 1) assert.equal(attempt.sessionId, 'original');
    const items = Array.from({ length: 7 }, (_, i) => i < n - 1 ? done(`stage${i}`) : ready(`stage${i}`));
    return { status: 'review', sessionId: 'original', summary: envelope(n === 8 ? 'complete' : 'continue', items,
      { progress: 'Progress is recorded in the stable ledger' }) };
  } };
  r.adapters.codex = adapter;
  await r.submit({ projectId: 'p', prompt: 'Finish all seven stages' });
  for (let i = 0; i < 9; i++) {
    await r.dispatcher.tick(); await r.assess();
    if (i === 3) {
      assert.equal((await r.snapshot()).tasks[0].status, 'queued');
      r = await new Runtime({ store: r.store, directory: os.tmpdir(), env: r.env, linearFactory: r.linearFactory }).init();
      r.adapters.codex = adapter;
    }
  }
  const t = (await r.snapshot()).tasks[0];
  assert.equal(starts, 8); assert.equal(t.status, 'review'); assert.equal(t.autoRounds, 7);
  assert.equal(t.previousAttempts.length, 7); assert.ok(t.workItems.every(i => i.status === 'done'));
});

test('checkpoint policy rejects cycling evidence, invented stages and endless fresh claims', () => {
  const prior = { ...ready('goal'), evidence: ['artifact A'] };
  const t = { autoRounds: 8, continuationIdleRounds: 3, workItems: [prior],
    rounds: [{ outcome: { workItems: [{ ...ready('goal'), evidence: ['artifact B'] }] } }] };
  const outcome = items => ({ workItems: items, progress: 'Another paraphrase' });
  assert.equal(continuationPolicy(t, outcome([{ ...prior, evidence: [' artifact   B '] }])).repeat, false);
  assert.equal(continuationPolicy(t, outcome([prior, done('invented')])).repeat, false);
  assert.equal(continuationPolicy(t, outcome([{ ...prior, evidence: ['artifact C'] }])).repeat, true);
  assert.equal(continuationPolicy({ ...t, autoRounds: 40 }, outcome([done('goal')])).repeat, false);
});
