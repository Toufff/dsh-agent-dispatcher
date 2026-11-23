import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { MemoryStore } from '../src/dispatcher.js';
import { initialState, settingsSchema } from '../src/config.js';
import { Runtime, effortFor } from '../src/runtime.js';
import { DshAdapter } from '../src/adapters/dsh.js';

const experiment = (extra = {}) => ({ enabled: true, arms: { even: 'medium', odd: 'high' }, projectIds: ['p'], ...extra });
async function fixture(effortExperiment = experiment(), { linear = true } = {}) {
  const store = new MemoryStore(), state = initialState();
  state.settings.projects = [{ id: 'p', label: 'Example', cwd: process.cwd() },
    { id: 'q', label: 'Other', cwd: process.cwd() }];
  if (effortExperiment) state.settings.effortExperiment = effortExperiment;
  await store.save(state);
  const runtime = await new Runtime({ store, directory: os.tmpdir(), env: { TEST_TOKEN: 'synthetic' },
    linearFactory: () => ({ eligible: async () => ({}) }) }).init();
  if (linear) await runtime.dispatcher.update(s => { s.settings.projects[0].linear = { enabled: true, tokenEnv: 'TEST_TOKEN' }; });
  const starts = [];
  runtime.adapters.codex = { start: async input => { starts.push(input); return { status: 'review', summary: 'Partial', sessionId: 'original' }; } };
  return { runtime, starts };
}
const issue = identifier => ({ id: `id-${identifier}`, identifier });

test('effort arms follow the parity of the Linear issue number; others do not take part', () => {
  const state = { settings: { effortExperiment: experiment() } };
  const task = (projectId, identifier) => ({ projectId, events: [], ...(identifier ? { issue: issue(identifier) } : {}) });
  const even = task('p', 'LON-212'), odd = task('p', 'LON-35');
  assert.deepEqual(effortFor(even, state), { arm: 'even', effort: 'medium', provider: 'leihuo', model: 'deepseek-flash' });
  assert.equal(effortFor(odd, state).effort, 'high');
  assert.equal(even.effortArm.arm, 'even'); assert.equal(even.events[0].action, 'effort-arm');
  assert.equal(effortFor(task('p'), state), null);
  assert.equal(effortFor(task('q', 'LON-2'), state), null);
  assert.equal(effortFor(task('p', 'LON-2'), { settings: { effortExperiment: experiment({ enabled: false }) } }), null);
  assert.equal(effortFor(task('p', 'LON-2'), { settings: { effortExperiment: experiment({ provider: 'x', model: 'y' }) } }).model, 'y');
  // A recorded arm is not recomputed, even if the experiment's arms change later.
  state.settings.effortExperiment.arms.even = 'low';
  assert.equal(effortFor(even, state).effort, 'medium');
});

test('the arm is persisted on first start and inherited by continuation and retry', async () => {
  const { runtime, starts } = await fixture();
  await runtime.submit({ projectId: 'p', prompt: 'Work', issue: issue('LON-212'), source: 'workspace/issue' });
  await runtime.command({ action: 'resume' }); await runtime.dispatcher.tick();
  let [task] = (await runtime.snapshot()).tasks;
  assert.deepEqual(task.effortArm && { arm: task.effortArm.arm, effort: task.effortArm.effort }, { arm: 'even', effort: 'medium' });
  assert.equal(starts[0].effort.effort, 'medium');
  // The experiment changes, the chain keeps its arm.
  await runtime.dispatcher.update(s => { s.settings.effortExperiment.arms.even = 'xhigh'; });
  await runtime.command({ action: 'continue', id: task.id }); await runtime.dispatcher.tick();
  const next = (await runtime.snapshot()).tasks[1];
  assert.equal(next.effortArm.effort, 'medium'); assert.equal(starts.at(-1).effort.effort, 'medium');
  assert.equal(next.events.filter(e => e.action === 'effort-arm').length, 0);
  runtime.adapters.codex.start = async input => { starts.push(input); return { status: 'failed', sessionId: 'original' }; };
  await runtime.command({ action: 'continue', id: next.id }).catch(() => {});
  await runtime.dispatcher.update(s => { const t = s.tasks.at(-1); t.status = 'failed'; });
  await runtime.retry((await runtime.snapshot()).tasks.at(-1).id); await runtime.dispatcher.tick();
  task = (await runtime.snapshot()).tasks.at(-1);
  assert.equal(task.effortArm.effort, 'medium'); assert.equal(starts.at(-1).effort.effort, 'medium');
});

test('no effort is passed while the experiment is off or absent', async () => {
  for (const setting of [experiment({ enabled: false }), null]) {
    const { runtime, starts } = await fixture(setting);
    await runtime.submit({ projectId: 'p', prompt: 'Work', issue: issue('LON-3'), source: 'workspace/issue' });
    await runtime.command({ action: 'resume' }); await runtime.dispatcher.tick();
    assert.equal(starts.length, 1); assert.equal(starts[0].effort, undefined);
    assert.equal((await runtime.snapshot()).tasks[0].effortArm, undefined);
  }
});

test('settings accept only known reasoning efforts and existing projects', () => {
  const base = initialState().settings; base.projects = [{ id: 'p', label: 'Example', cwd: process.cwd() }];
  assert.equal(settingsSchema.parse({ ...base, effortExperiment: experiment({ arms: { even: 'off', odd: 'max' } }) }).effortExperiment.arms.odd, 'max');
  assert.throws(() => settingsSchema.parse({ ...base, effortExperiment: experiment({ arms: { even: 'medium', odd: 'ultra' } }) }));
  assert.throws(() => settingsSchema.parse({ ...base, effortExperiment: experiment({ projectIds: ['missing'] }) }), /does not exist/);
  assert.throws(() => settingsSchema.parse({ ...base, effortExperiment: { ...experiment(), extra: 1 } }));
});

test('changing the effort experiment is allowed while project tasks are active', async () => {
  const { runtime } = await fixture(null, { linear: false });
  await runtime.submit({ projectId: 'p', prompt: 'Work' });
  let snapshot = await runtime.snapshot();
  const settings = structuredClone(snapshot.settings);
  settings.effortExperiment = experiment();
  await runtime.configure(settings, snapshot.revision);
  snapshot = await runtime.snapshot();
  assert.equal(snapshot.settings.effortExperiment.arms.odd, 'high');
  const off = structuredClone(snapshot.settings); off.effortExperiment.enabled = false;
  await runtime.configure(off, snapshot.revision);
  assert.equal((await runtime.snapshot()).settings.effortExperiment.enabled, false);
});

const effort = { arm: 'odd', effort: 'high', provider: 'leihuo', model: 'deepseek-flash' };
function dshContext({ current, select = () => {} } = {}) {
  const calls = [], order = [];
  const agent = { status: 'idle', inbox: { nextTurn: [], nextStep: [] },
    model: { current: () => current, select: selection => { order.push('select'); calls.push(selection); return select(selection); } } };
  const ctx = { agents: { get: () => undefined }, sessionController: {
    inspect: async () => ({ meta: { cwd: process.cwd() }, events: [] }),
    create: async request => ({ sessionId: request.sessionId }),
    resolveAgent: async () => ({ agent }), prompt: async () => { order.push('prompt'); } } };
  return { ctx, calls, order };
}
const task = { cwd: process.cwd(), prompt: 'p' };

test('DSH selects the effort before prompting, for new and resumed sessions', async () => {
  const fresh = dshContext();
  const created = await new DshAdapter(fresh.ctx).start({ task, attempt: { id: 'a', sessionId: 's' }, effort });
  assert.deepEqual(fresh.calls, [{ provider: 'leihuo', model: 'deepseek-flash', reasoningEffort: 'high' }]);
  assert.deepEqual(fresh.order, ['select', 'prompt']);
  assert.deepEqual(created.effort, { effort: 'high', arm: 'odd', provider: 'leihuo', model: 'deepseek-flash' });
  // A resumed session keeps its current route and only changes effort.
  const resumed = dshContext({ current: { provider: 'other', model: 'pro', reasoningEffort: 'low' } });
  const result = await new DshAdapter(resumed.ctx).start({ task, attempt: { id: 'a', sessionId: 'old', resume: true }, effort });
  assert.equal(result.status, 'running');
  assert.deepEqual(resumed.calls, [{ provider: 'other', model: 'pro', reasoningEffort: 'high' }]);
});

test('DSH does not select without the experiment, and a failed select never blocks the round', async () => {
  const off = dshContext();
  const plain = await new DshAdapter(off.ctx).start({ task, attempt: { id: 'a', sessionId: 's' } });
  assert.equal(off.calls.length, 0); assert.equal(plain.effort, undefined); assert.deepEqual(off.order, ['prompt']);
  const failing = dshContext({ select: () => { throw new Error('boom'); } });
  const result = await new DshAdapter(failing.ctx).start({ task, attempt: { id: 'a', sessionId: 's' }, effort });
  assert.equal(result.status, 'running'); assert.equal(result.effort.error, 'boom'); assert.deepEqual(failing.order, ['select', 'prompt']);
});

test('select results are recorded as task events', async () => {
  const { runtime } = await fixture();
  let effortResult = { effort: 'medium', arm: 'even', provider: 'leihuo', model: 'deepseek-flash' };
  runtime.adapters.codex = { start: async () => ({ status: 'review', summary: 'Partial', sessionId: 's', effort: effortResult }) };
  await runtime.submit({ projectId: 'p', prompt: 'Work', issue: issue('LON-4'), source: 'workspace/issue' });
  await runtime.command({ action: 'resume' }); await runtime.dispatcher.tick();
  let events = (await runtime.snapshot()).tasks[0].events;
  assert.deepEqual(events.filter(e => e.action.startsWith('effort-')).map(e => e.action), ['effort-arm', 'effort-selected']);
  assert.equal(events.find(e => e.action === 'effort-selected').arm, 'even');
  effortResult = { effort: 'high', arm: 'odd', error: 'boom' };
  await runtime.submit({ projectId: 'p', prompt: 'Work', issue: issue('LON-5'), source: 'workspace/issue-5' });
  await runtime.dispatcher.tick();
  events = (await runtime.snapshot()).tasks.find(t => t.issue.identifier === 'LON-5').events;
  assert.equal(events.find(e => e.action === 'effort-select-failed').error, 'boom');
});
