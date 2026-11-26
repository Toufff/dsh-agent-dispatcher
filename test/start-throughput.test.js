import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { Dispatcher, MemoryStore, startLimit } from '../src/dispatcher.js';
import { initialState, settingsSchema } from '../src/config.js';
import { Runtime } from '../src/runtime.js';
import { DshAdapter } from '../src/adapters/dsh.js';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const enqueue = (dispatcher, n, extra = {}) => dispatcher.enqueue({ source: `w/issue-${n}`, round: '1', prompt: 'p', executors: ['first'], cwd: `/work/${n}`, ...extra });

test('one tick starts every free slot up to startConcurrency, with admission checks in parallel', async () => {
  const store = new MemoryStore();
  await store.save({ tasks: [], settings: { concurrency: 10, executors: [], projects: [] } });
  let inFlight = 0, peak = 0, starts = 0;
  const dispatcher = new Dispatcher({ store, adapters: { first: { start: async () => { starts++; await delay(5); return { status: 'running' }; } } },
    beforeStart: async () => { inFlight++; peak = Math.max(peak, inFlight); await delay(20); inFlight--; } });
  for (let n = 0; n < 8; n++) await enqueue(dispatcher, n);
  await dispatcher.tick();
  assert.equal(starts, 6, 'default startConcurrency is 6');
  assert.equal(peak, 6, 'admission checks overlap');
  await dispatcher.tick();
  assert.equal(starts, 8);
  assert.deepEqual((await store.load()).tasks.map(t => t.status), Array(8).fill('running'));
});

test('the global limit still caps a tick, and startConcurrency is configurable', async () => {
  for (const [settings, expected] of [[{ concurrency: 3 }, 3], [{ concurrency: 10, startConcurrency: 2 }, 2]]) {
    const store = new MemoryStore();
    await store.save({ tasks: [], settings: { ...settings, executors: [], projects: [] } });
    let starts = 0;
    const dispatcher = new Dispatcher({ store, adapters: { first: { start: async () => { starts++; return { status: 'running' }; } } } });
    for (let n = 0; n < 5; n++) await enqueue(dispatcher, n);
    await dispatcher.tick();
    assert.equal(starts, expected);
  }
  assert.equal(startLimit({ settings: {} }), 6);
  const settings = initialState().settings;
  assert.equal(settingsSchema.parse({ ...settings, startConcurrency: 4 }).startConcurrency, 4);
  assert.throws(() => settingsSchema.parse({ ...settings, startConcurrency: 0 }));
});

test('in a multi-start tick one failed admission or rejected start does not hold the others', async () => {
  const store = new MemoryStore();
  await store.save({ tasks: [], settings: { concurrency: 10, executors: [], projects: [] } });
  const started = [];
  const dispatcher = new Dispatcher({ store,
    adapters: { first: { start: async ({ task }) => task.cwd === '/work/2' ? { status: 'rejected' } : (started.push(['first', task.cwd]), { status: 'running' }) },
      second: { start: async ({ task }) => { started.push(['second', task.cwd]); return { status: 'running' }; } } },
    beforeStart: async task => { if (task.cwd === '/work/1') throw new Error('Linear down'); } });
  for (let n = 0; n < 4; n++) await enqueue(dispatcher, n, { executors: ['first', 'second'] });
  await dispatcher.tick();
  const tasks = (await store.load()).tasks;
  assert.deepEqual(tasks.map(t => t.status), ['running', 'queued', 'running', 'running']);
  assert.match(tasks[1].admissionError, /复核未通过/);
  assert.deepEqual(tasks[2].attempts.map(a => [a.executor, a.status]), [['first', 'rejected'], ['second', 'running']]);
  assert.deepEqual(started.sort(), [['first', '/work/0'], ['first', '/work/3'], ['second', '/work/2']]);
});

test('every start intent of a multi-start tick is durable before the first start call', async () => {
  const saved = [];
  const store = { state: { tasks: [], settings: { concurrency: 10, executors: [], projects: [] } },
    async load() { return structuredClone(this.state); }, async save(state) { this.state = structuredClone(state); saved.push(state.tasks.map(t => t.status)); } };
  let seen;
  const dispatcher = new Dispatcher({ store, adapters: { first: { start: async () => { seen ??= saved.at(-1); return { status: 'running' }; } } } });
  for (let n = 0; n < 3; n++) await enqueue(dispatcher, n);
  await dispatcher.tick();
  assert.deepEqual(seen, ['starting', 'starting', 'starting']);
});

test('parallel DSH starts in one project register a missing Workspace once', async () => {
  let creates = 0;
  const registry = { resolveByPath: async () => undefined, create: async () => { creates++; await delay(5); return { id: 'ws' }; } };
  const adapter = new DshAdapter({ workspaceRegistry: registry, sessionController: {
    create: async request => ({ sessionId: request.sessionId }), prompt: async () => {} } });
  const results = await Promise.all([1, 2, 3].map(n => adapter.start({ task: { cwd: '/work/p', prompt: 'p' }, attempt: { id: `a${n}`, sessionId: `s${n}` } })));
  assert.deepEqual(results.map(r => r.status), ['running', 'running', 'running']);
  assert.equal(creates, 1);
});

async function sweepRuntime(store, calls) {
  return new Runtime({ store, commentSweepMs: 0, directory: os.tmpdir(), env: { TEST_TOKEN: 'synthetic' }, linearFactory: () => ({
    eligible: async () => ({}),
    commentedIssues: async () => { calls.sweep++; return new Set(calls.flagged || []); },
    activity: async () => { calls.activity++; return { comments: [] }; } }) }).init();
}

test('the comment sweep cursor and unread issues survive a restart: no full re-read of every issue', async () => {
  const store = new MemoryStore(), state = initialState();
  state.paused = false;
  state.settings.projects = [{ id: 'p', label: 'Example', cwd: process.cwd(),
    linear: { enabled: true, tokenEnv: 'TEST_TOKEN', workspaceId: 'w', projectId: 'proj', assigneeId: 'me', round: '1', reviewStateId: 'review' },
    followup: { enabled: true, commentAuthorIds: ['peer', 'me'], maxWakeups: 8, reviewComments: true } }];
  await store.save(state);
  const calls = { sweep: 0, activity: 0 };
  let runtime = await sweepRuntime(store, calls);
  runtime.adapters.codex = { start: async () => ({ status: 'review', summary: 'x', sessionId: 's' }) };
  for (const n of [1, 2]) await runtime.submit({ projectId: 'p', prompt: 'Work', issue: { id: `issue-${n}`, identifier: `EX-${n}` }, source: `w/issue-${n}` });
  await runtime.dispatcher.update(s => { for (const t of s.tasks) { t.status = 'review'; t.assessed = true; } });
  await runtime.reviewComments();                         // very first pass: one full read of each issue
  assert.equal(calls.activity, 2);
  calls.flagged = ['issue-2'];
  runtime.reviewCheckedAt.set((await runtime.snapshot()).tasks[1].id, Date.now() + 60000);
  await runtime.reviewComments();                         // issue-2 flagged but not due: stays dirty
  assert.equal(calls.activity, 2);
  assert.deepEqual((await store.load()).commentSweep.dirty, ['issue-2']);
  // restart
  calls.flagged = [];
  runtime = await sweepRuntime(store, calls);
  await runtime.reviewComments();
  assert.equal(calls.sweep, 3, 'the persisted cursor is used');
  assert.equal(calls.activity, 3, 'only the still-dirty issue is read');
  assert.deepEqual((await store.load()).commentSweep.dirty, []);
});

test('a cycle starts queued tasks before the comment pass', async () => {
  const store = new MemoryStore(), state = initialState();
  state.paused = false;
  await store.save(state);
  const runtime = await new Runtime({ store, commentSweepMs: 0, directory: os.tmpdir(), env: {} }).init();
  const order = [];
  runtime.dispatcher.tick = async () => { order.push('execution'); };
  runtime.reviewComments = async () => { order.push('comments'); };
  runtime.dataWakes = async () => { order.push('data'); };
  await runtime.cycle();
  assert.deepEqual(order, ['execution', 'comments', 'data']);
});
