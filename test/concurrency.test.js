import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Dispatcher, MemoryStore } from '../src/dispatcher.js';

const base = { source: 'example-workspace/issue', prompt: 'Synthetic fixture', executors: ['first'] };
const running = () => { let calls = 0; return { calls: () => calls,
  adapter: { start: async () => { calls++; return { status: 'running' }; },
    reconcile: async () => ({ status: 'review', summary: 'done' }) } }; };

async function setup(settings) {
  const store = new MemoryStore();
  await store.save({ tasks: [], settings });
  return store;
}
const enqueue = (dispatcher, n, extra) => dispatcher.enqueue({ ...base, source: `${base.source}-${n}`, round: '1', ...extra });
async function tickTimes(dispatcher, n) { for (let i = 0; i < n; i++) await dispatcher.tick(); }

test('without concurrency settings only one task runs at a time', async () => {
  const store = await setup({ executors: [], projects: [{ id: 'p', maxConcurrent: 4 }] });
  const r = running();
  const dispatcher = new Dispatcher({ store, adapters: { first: r.adapter } });
  for (const n of [1, 2]) await enqueue(dispatcher, n, { cwd: '/work/p', projectId: 'p' });
  await tickTimes(dispatcher, 3);
  assert.equal(r.calls(), 1);
});

test('project maxConcurrent and global concurrency both cap running tasks', async () => {
  const store = await setup({ concurrency: 2, executors: [], projects: [{ id: 'p', maxConcurrent: 3 }] });
  const r = running();
  const dispatcher = new Dispatcher({ store, adapters: { first: r.adapter } });
  for (const n of [1, 2, 3]) await enqueue(dispatcher, n, { cwd: '/work/p', projectId: 'p' });
  await tickTimes(dispatcher, 4);
  assert.equal(r.calls(), 2);
  assert.deepEqual((await store.load()).tasks.map(t => t.status), ['running', 'running', 'queued']);
});

test('a project without maxConcurrent stays serial under a higher global limit', async () => {
  const store = await setup({ concurrency: 3, executors: [], projects: [{ id: 'a' }, { id: 'b' }] });
  const r = running();
  const dispatcher = new Dispatcher({ store, adapters: { first: r.adapter } });
  await enqueue(dispatcher, 1, { cwd: '/work/a', projectId: 'a' });
  await enqueue(dispatcher, 2, { cwd: '/work/a', projectId: 'a' });
  await enqueue(dispatcher, 3, { cwd: '/work/b', projectId: 'b' });
  await tickTimes(dispatcher, 4);
  // FIFO skips the blocked second task of project a and starts project b.
  assert.deepEqual((await store.load()).tasks.map(t => t.status), ['running', 'queued', 'running']);
});

test('different projects sharing one directory never run together', async () => {
  const store = await setup({ concurrency: 3, executors: [], projects: [{ id: 'a', maxConcurrent: 2 }, { id: 'b', maxConcurrent: 2 }] });
  const r = running();
  const dispatcher = new Dispatcher({ store, adapters: { first: r.adapter } });
  await enqueue(dispatcher, 1, { cwd: '/work/shared', projectId: 'a' });
  await enqueue(dispatcher, 2, { cwd: '/work/shared', projectId: 'b' });
  await tickTimes(dispatcher, 3);
  assert.deepEqual((await store.load()).tasks.map(t => t.status), ['running', 'queued']);
});

test('reconcile visits every running task and frees their slots', async () => {
  const store = await setup({ concurrency: 2, executors: [], projects: [{ id: 'p', maxConcurrent: 2 }] });
  const r = running();
  const dispatcher = new Dispatcher({ store, adapters: { first: r.adapter } });
  for (const n of [1, 2, 3]) await enqueue(dispatcher, n, { cwd: '/work/p', projectId: 'p' });
  await tickTimes(dispatcher, 2);
  await dispatcher.reconcile();
  const after = (await store.load()).tasks.map(t => t.status);
  assert.deepEqual(after, ['review', 'review', 'queued']);
  await dispatcher.tick();
  assert.equal((await store.load()).tasks[2].status, 'running');
});

test('one failing reconcile does not skip the other running tasks', async () => {
  const store = await setup({ concurrency: 2, executors: [], projects: [{ id: 'p', maxConcurrent: 2 }] });
  let failed = false;
  const flaky = { load: () => store.load(), save: async state => {
    // The first persisted review of t-1 hits a transient storage failure.
    if (!failed && state.tasks.find(t => t.title === 't-1')?.status === 'review') { failed = true; throw new Error('disk unavailable'); }
    return store.save(state);
  } };
  const dispatcher = new Dispatcher({ store: flaky, adapters: { first: { start: async () => ({ status: 'running' }),
    reconcile: async () => ({ status: 'review', summary: 'done' }) } } });
  for (const n of [1, 2]) await enqueue(dispatcher, n, { cwd: '/work/p', projectId: 'p', title: `t-${n}` });
  await tickTimes(dispatcher, 2);
  await assert.rejects(dispatcher.reconcile(), /disk unavailable/);
  assert.deepEqual((await store.load()).tasks.map(t => t.status), ['running', 'review']);
  await dispatcher.reconcile();
  assert.deepEqual((await store.load()).tasks.map(t => t.status), ['review', 'review']);
});
