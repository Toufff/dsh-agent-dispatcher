import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Dispatcher, MemoryStore } from '../src/dispatcher.js';

const input = { source: 'example-workspace/example-issue', round: '1',
  cwd: '/example/project', prompt: 'Review the synthetic fixture', executors: ['first', 'second'] };
const accepted = { start: async () => ({ status: 'running', sessionId: 'synthetic-session' }) };

test('accepted execution cannot fall back after an intervening unknown result', async () => {
  const store = new MemoryStore();
  let checks = 0;
  const dispatcher = new Dispatcher({ store, adapters: { first: {
    ...accepted,
    reconcile: async () => ({ status: ++checks === 1 ? 'unknown' : 'rejected' })
  } } });
  await dispatcher.enqueue(input);
  await dispatcher.tick();
  await dispatcher.reconcile();
  await dispatcher.reconcile();
  await dispatcher.tick();
  const task = (await store.load()).tasks[0];
  assert.equal(task.status, 'unknown');
  assert.equal(task.attempts.length, 1);
});

test('deduplicates simultaneous intake and starts only one task', async () => {
  let calls = 0;
  const store = new MemoryStore();
  const dispatcher = new Dispatcher({ store, adapters: { first: {
    start: async () => { calls++; return { status: 'running' }; }
  } } });
  const ids = await Promise.all([dispatcher.enqueue(input), dispatcher.enqueue(input)]);
  assert.equal(ids[0], ids[1]);
  await dispatcher.enqueue({ ...input, round: '2' });
  await Promise.all([dispatcher.tick(), dispatcher.tick()]);
  assert.equal(calls, 1);
});

test('only definitive pre-start rejection permits ordered fallback', async () => {
  const store = new MemoryStore();
  const dispatcher = new Dispatcher({ store, adapters: {
    first: { start: async () => ({ status: 'rejected' }) }, second: accepted
  } });
  await dispatcher.enqueue(input);
  await dispatcher.tick();
  const task = (await store.load()).tasks[0];
  assert.deepEqual(task.attempts.map(a => a.status), ['rejected', 'running']);
  assert.equal(task.attempts[1].sessionId, 'synthetic-session');
});

for (const outcome of ['unknown', 'waiting', 'finishing', 'failed', 'review']) {
  test(`${outcome} never starts the next executor`, async () => {
    let second = 0;
    const store = new MemoryStore();
    const dispatcher = new Dispatcher({ store, adapters: {
      first: { start: async () => ({ status: outcome }) },
      second: { start: async () => { second++; return { status: 'running' }; } }
    } });
    await dispatcher.enqueue(input);
    await dispatcher.tick();
    await dispatcher.tick();
    assert.equal(second, 0);
    assert.equal((await store.load()).tasks[0].status, outcome);
  });
}

test('restart after uncertain start reconciles instead of starting again', async () => {
  const store = new MemoryStore();
  let calls = 0;
  const adapters = { first: {
    start: async () => { calls++; throw new Error('transport interrupted'); },
    reconcile: async () => ({ status: 'running', runId: 'existing-run' })
  } };
  const first = new Dispatcher({ store, adapters });
  await first.enqueue(input);
  await first.tick();
  const restarted = new Dispatcher({ store, adapters });
  await restarted.tick();
  await restarted.reconcile();
  assert.equal(calls, 1);
  assert.equal((await store.load()).tasks[0].attempts[0].runId, 'existing-run');
});

test('failed intent persistence prevents any external start', async () => {
  const store = new MemoryStore();
  let calls = 0;
  const dispatcher = new Dispatcher({ store, adapters: { first: {
    start: async () => { calls++; return { status: 'running' }; }
  } } });
  await dispatcher.enqueue(input);
  store.save = async () => { throw new Error('disk unavailable'); };
  await assert.rejects(dispatcher.tick(), /disk unavailable/);
  assert.equal(calls, 0);
});

test('completion permits next FIFO task but remains pending human review', async () => {
  const store = new MemoryStore();
  let calls = 0;
  const dispatcher = new Dispatcher({ store, adapters: { first: {
    start: async () => { calls++; return { status: 'running' }; },
    reconcile: async () => ({ status: 'review' })
  } } });
  await dispatcher.enqueue(input);
  await dispatcher.enqueue({ ...input, round: '2' });
  await dispatcher.tick();
  await dispatcher.reconcile();
  await dispatcher.tick();
  assert.equal(calls, 2);
  assert.deepEqual((await store.load()).tasks.map(t => t.status), ['review', 'running']);
});

test('finishing keeps the execution slot until process cleanup is confirmed', async () => {
  const store = new MemoryStore();
  let calls = 0, status = 'finishing';
  const dispatcher = new Dispatcher({ store, adapters: { first: {
    start: async () => { calls++; return { status: 'running' }; },
    reconcile: async () => ({ status })
  } } });
  await dispatcher.enqueue(input);
  await dispatcher.enqueue({ ...input, round: '2' });
  await dispatcher.tick();
  await dispatcher.reconcile();
  await dispatcher.tick();
  assert.equal(calls, 1);
  status = 'review';
  await dispatcher.reconcile();
  await dispatcher.tick();
  assert.equal(calls, 2);
});
