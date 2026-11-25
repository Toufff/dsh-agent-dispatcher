// A host restart used to strand every running round: the DSH adapter saw no turn/end and answered 'unknown', which
// neither continue nor retry accepts, so a release could only be rolled out once all rounds happened to finish.
// Now that case is 'interrupted': the task is requeued with its session kept, so start() resumes the same session.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DshAdapter } from '../src/adapters/dsh.js';
import { Dispatcher, MemoryStore } from '../src/dispatcher.js';

const page = (events, hasMore, cursor) => ({ cursor, hasMore, records: events.map(event => ({ type: 'event', event })) });
const seqd = list => list.map((e, seq) => ({ seq, ...e }));
const admitted = { type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, inserted: [{ id: 'm', source: { rpcId: 'attempt' } }] } };

const adapterWith = (events, agent = undefined) => new DshAdapter({
  agents: { get: () => agent },
  sessionController: { events: async () => page(seqd(events), false, 99) },
});

test('adapter: an admitted round with no turn/end and no live agent is interrupted, not unknown', async () => {
  const result = await adapterWith([admitted, { type: 'assistant/message', data: { message: { content: [] } } }])
    .reconcile({ attempt: { id: 'attempt', sessionId: 'session', status: 'running' } });
  assert.equal(result.status, 'interrupted');
  assert.match(result.reason, /resume/);
});

test('adapter: a live agent still reports running, and a completed turn still reports review', async () => {
  const live = { status: 'running', inbox: { nextTurn: [], nextStep: [] },
    session: { header: { cwd: '/work' }, snapshotEvents: () => seqd([admitted]) } };
  assert.equal((await adapterWith([admitted], live).reconcile({ attempt: { id: 'attempt', sessionId: 'session', status: 'running' } })).status, 'running');
  const done = await adapterWith([admitted, { type: 'turn/end', data: { reason: { kind: 'completed' } } }])
    .reconcile({ attempt: { id: 'attempt', sessionId: 'session', status: 'running' } });
  assert.equal(done.status, 'review');
});

test('adapter: without prompt admission in history the round stays unknown (nothing to resume)', async () => {
  const result = await adapterWith([{ type: 'assistant/message', data: { message: { content: [] } } }])
    .reconcile({ attempt: { id: 'attempt', sessionId: 'session', status: 'running' } });
  assert.equal(result.status, 'unknown');
});

test('adapter: an agent that is detached but still idle is not treated as a restart', async () => {
  const idle = { status: 'idle', inbox: { nextTurn: [], nextStep: [] } };
  const result = await adapterWith([admitted], idle).reconcile({ attempt: { id: 'attempt', sessionId: 'session', status: 'running' } });
  assert.equal(result.status, 'unknown');
});

const input = { source: 'example-workspace/example-issue', round: '1',
  cwd: '/example/project', prompt: 'Review the synthetic fixture', executors: ['first'] };

test('dispatcher: interrupted requeues the task on the same session instead of parking it', async () => {
  const store = new MemoryStore();
  const dispatcher = new Dispatcher({ store, adapters: { first: {
    start: async () => ({ status: 'running', sessionId: 'synthetic-session' }),
    reconcile: async () => ({ status: 'interrupted', reason: 'Host restarted mid-round' }),
  } } });
  await dispatcher.enqueue(input);
  await dispatcher.tick();
  await dispatcher.reconcile();
  const task = (await store.load()).tasks[0];
  assert.equal(task.status, 'queued');
  assert.equal(task.attempts.length, 0);
  assert.deepEqual(task.session, { executor: 'first', id: 'synthetic-session' });
  assert.equal(task.previousAttempts.length, 1, 'the interrupted attempt is kept as history');
  assert.ok(task.events.some(e => e.action === 'interrupted'));
  assert.equal(task.report, 'pending');
});

test('dispatcher: the requeued round starts again with attempt.resume on that session', async () => {
  const started = [];
  const store = new MemoryStore();
  const dispatcher = new Dispatcher({ store, adapters: { first: {
    start: async ({ attempt }) => { started.push(attempt); return { status: 'running', sessionId: attempt.sessionId }; },
    reconcile: async () => ({ status: 'interrupted', reason: 'Host restarted mid-round' }),
  } } });
  await dispatcher.enqueue(input);
  await dispatcher.tick();
  await dispatcher.reconcile();
  await dispatcher.tick();
  assert.equal(started.length, 2);
  assert.equal(started[1].sessionId, started[0].sessionId, 'the same session is resumed');
  assert.equal(started[1].resume, true);
  assert.equal((await store.load()).tasks[0].status, 'running');
});

test('dispatcher: repeated restarts keep requeueing without piling up attempts or executors', async () => {
  const store = new MemoryStore();
  let rounds = 0;
  const dispatcher = new Dispatcher({ store, adapters: { first: {
    start: async ({ attempt }) => ({ status: 'running', sessionId: attempt.sessionId }),
    reconcile: async () => (rounds++ < 3 ? { status: 'interrupted', reason: 'restart' } : { status: 'running' }),
  } } });
  await dispatcher.enqueue(input);
  for (let i = 0; i < 3; i++) { await dispatcher.tick(); await dispatcher.reconcile(); }
  await dispatcher.tick();
  const task = (await store.load()).tasks[0];
  assert.equal(task.status, 'running');
  assert.ok(task.attempts.length <= 1, `attempts ${task.attempts.length}`);
  assert.deepEqual(task.executors, ['first']);
});

test('dispatcher: unknown is still a dead end (unchanged), so only restarts are auto-resumed', async () => {
  const store = new MemoryStore();
  const dispatcher = new Dispatcher({ store, adapters: { first: {
    start: async () => ({ status: 'running', sessionId: 'synthetic-session' }),
    reconcile: async () => ({ status: 'unknown', reason: 'admission missing' }),
  } } });
  await dispatcher.enqueue(input);
  await dispatcher.tick();
  await dispatcher.reconcile();
  const task = (await store.load()).tasks[0];
  assert.equal(task.status, 'unknown');
  assert.equal(task.attempts.length, 1);
});
