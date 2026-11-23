import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { TaskStore, MemoryBackend, shadowOf, sameAs } from '../src/state-store.js';
import { SingleDocumentBackend } from '../src/store.js';
import { Dispatcher } from '../src/dispatcher.js';
import { Runtime } from '../src/runtime.js';
import { initialState } from '../src/config.js';

const task = (id, extra = {}) => ({ id, key: JSON.stringify(['local', id]), cwd: '/work', prompt: 'p', title: id, executors: ['first'],
  status: 'review', attempts: [{ id: `${id}-a`, executor: 'first', status: 'review', accepted: true, sessionId: 's' }],
  report: 'sent', owner: 'scheduler', events: [{ action: 'review', at: '2026-01-01T00:00:00Z' }], ...extra });
async function open(initial = { version: 1, revision: 0, paused: false, settings: { executors: [], projects: [] },
  tasks: [task('a'), task('b'), task('c')], outbox: [{ id: 'o1', taskId: 'a', status: 'sent', tries: 0 }] }, options = {}) {
  const backend = new MemoryBackend(initial);
  const store = await new TaskStore(backend, options).open();
  return { backend, store, dispatcher: new Dispatcher({ store, adapters: {} }) };
}

test('shadows detect in-place changes at the depths the dispatcher mutates', () => {
  const t = task('a', { wait: { seen: ['x'], status: 'watching' } }), shadow = shadowOf(t);
  assert.ok(sameAs(t, shadow));
  t.attempts[0].status = 'running'; assert.ok(!sameAs(t, shadow));
  const u = task('b', { wait: { seen: ['x'] } }), s2 = shadowOf(u);
  u.wait.seen.push('y'); assert.ok(!sameAs(u, s2));
  const v = task('c'), s3 = shadowOf(v); v.extra = undefined; assert.ok(!sameAs(v, s3));
});

test('an update writes only the records it changed, without copying the whole state', async () => {
  const { backend, store, dispatcher } = await open();
  backend.writes.length = 0;
  await dispatcher.update(s => { s.tasks.find(t => t.id === 'b').report = 'pending'; });
  assert.equal(backend.writes.length, 1);
  assert.deepEqual(backend.writes[0].puts.map(p => p.id), ['b']);
  assert.equal(backend.writes[0].global, undefined);
  await dispatcher.update(() => {});
  assert.equal(backend.writes.length, 1, 'an update without changes writes nothing');
  await dispatcher.update(s => { s.paused = true; });
  assert.deepEqual(backend.writes[1].puts, []); assert.equal(JSON.parse(backend.writes[1].global).paused, true);
  assert.equal((await store.read()).paused, true);
});

test('a throwing update leaves the state untouched and unchanged records keep their identity', async () => {
  const { backend, store, dispatcher } = await open();
  const before = await store.load(), live = await store.begin(), untouched = live.tasks[2];
  backend.writes.length = 0;
  await assert.rejects(dispatcher.update(s => {
    s.tasks[0].status = 'failed'; s.tasks[1].attempts[0].status = 'x'; s.tasks.push(task('d')); s.outbox.length = 0; s.revision = 9;
    throw new Error('invalid request');
  }), /invalid request/);
  assert.deepEqual(await store.load(), before);
  assert.equal((await store.begin()).tasks[2], untouched);
  assert.equal(backend.writes.length, 0);
});

test('updates of one deferred cycle are persisted together; durable checkpoints persist at once', async () => {
  const { backend, store, dispatcher } = await open();
  backend.writes.length = 0;
  await store.deferred(async () => {
    await dispatcher.update(s => { s.tasks[0].report = 'pending'; });
    await dispatcher.update(s => { s.tasks[1].report = 'pending'; });
    assert.equal(backend.writes.length, 0, 'deferred updates are not written yet');
    assert.equal((await store.read()).tasks[0].report, 'pending', 'readers see committed deferred changes');
    await dispatcher.update(s => { s.tasks[2].report = 'pending'; }, { durable: true });
    assert.equal(backend.writes.length, 1);
    assert.deepEqual(backend.writes[0].puts.map(p => p.id).sort(), ['a', 'b', 'c']);
    await dispatcher.update(s => { s.tasks[0].report = 'queued'; });
  });
  assert.equal(backend.writes.length, 1);
  await dispatcher.flush();
  assert.equal(backend.writes.length, 2); assert.deepEqual(backend.writes[1].puts.map(p => p.id), ['a']);
});

test('a failed write returns to the persisted state and can be retried; partial writes leave no ghost record', async () => {
  const { backend, store, dispatcher } = await open();
  const before = await store.load();
  backend.fail = () => new Error('disk unavailable');
  await assert.rejects(dispatcher.update(s => { s.tasks[0].status = 'accepted'; }), /disk unavailable/);
  assert.deepEqual(await store.load(), before);
  backend.fail = null;
  await dispatcher.update(s => { s.tasks[0].status = 'accepted'; });
  assert.equal(JSON.parse(backend.records.tasks.get('a')).status, 'accepted');
  // The new record reaches the medium, the global order does not.
  backend.failAfter = 1;
  await assert.rejects(dispatcher.update(s => { s.tasks.push(task('d')); s.tasks.push(task('e')); }), /disk unavailable/);
  assert.equal((await store.read()).tasks.length, 3);
  assert.ok(backend.records.tasks.has('d'));
  await dispatcher.update(s => { s.revision++; });
  assert.ok(!backend.records.tasks.has('d'), 'the orphan of the failed write is removed');
  const reopened = await new TaskStore(backend).open();
  assert.deepEqual((await reopened.read()).tasks.map(t => t.id), ['a', 'b', 'c']);
});

test('a record written before its order reached the medium is recovered on reopen', async () => {
  const backend = new MemoryBackend({ version: 1, tasks: [task('a')], outbox: [] });
  backend.records.tasks.set('z', JSON.stringify(task('z')));
  const store = await new TaskStore(backend).open();
  assert.deepEqual((await store.read()).tasks.map(t => t.id), ['a', 'z']);
});

test('readers get frozen views that share unchanged records', async () => {
  const { store, dispatcher } = await open();
  const first = await store.read();
  assert.throws(() => { first.tasks[0].status = 'x'; }, TypeError);
  await dispatcher.update(s => { s.tasks[1].report = 'pending'; });
  const second = await store.read();
  assert.equal(second.tasks[0], first.tasks[0]);
  assert.notEqual(second.tasks[1], first.tasks[1]);
  assert.equal(first.tasks[1].report, 'sent');
});

test('a kernel section scoped to one task still records order changes, and verification catches deep edits', async () => {
  let now = 0;
  const { backend, store } = await open(undefined, { clock: () => now });
  const live = await store.begin();
  live.tasks[0].attempts[0].status = 'running';
  await store.checkpoint(live, { tasks: ['a'] });
  assert.equal(JSON.parse(backend.records.tasks.get('a')).attempts[0].status, 'running');
  // Deeper than any shadow: only the periodic full comparison sees it.
  live.tasks[1].deep = { a: { b: { c: { d: { e: { f: 1 } } } } } };
  await store.checkpoint(live);
  live.tasks[1].deep.a.b.c.d.e.f = 2;
  await store.checkpoint(live);
  assert.equal(JSON.parse(backend.records.tasks.get('b')).deep.a.b.c.d.e.f, 1);
  now = 120000;
  await store.checkpoint(live);
  assert.equal(JSON.parse(backend.records.tasks.get('b')).deep.a.b.c.d.e.f, 2);
});

test('runtime commands persist before returning, even when called inside a deferred cycle', async () => {
  const state = initialState(); state.paused = false;
  const backend = new MemoryBackend(state), store = await new TaskStore(backend).open();
  const runtime = await new Runtime({ store, directory: os.tmpdir(), env: {} }).init();
  await store.deferred(async () => {
    await runtime.command({ action: 'pause' });
    assert.equal(JSON.parse(backend.global).paused, true);
  });
});

test('the dispatcher runs end to end on the tracked store and persists intent before starting', async () => {
  const backend = new MemoryBackend({ version: 1, tasks: [], outbox: [], settings: { executors: [], projects: [] } });
  const store = await new TaskStore(backend).open();
  let persistedAtStart;
  const dispatcher = new Dispatcher({ store, adapters: { first: {
    start: async () => { persistedAtStart = JSON.parse([...backend.records.tasks.values()][0]).status; return { status: 'running' }; },
    reconcile: async () => ({ status: 'review', summary: 'done' }) } } });
  await store.deferred(async () => {
    await dispatcher.enqueue({ source: 's', round: '1', cwd: '/w', prompt: 'p', executors: ['first'] });
    await dispatcher.tick();
    assert.equal(persistedAtStart, 'starting');
    await dispatcher.reconcile();
  });
  await dispatcher.flush();
  const stored = JSON.parse([...backend.records.tasks.values()][0]);
  assert.equal(stored.status, 'review'); assert.equal(stored.summary, 'done');
});

test('the single-document backend rewrites the document only when something changed', async () => {
  let value = { version: 1, revision: 0, paused: true, settings: { executors: [], projects: [] }, tasks: [task('a')], outbox: [] }, sets = 0;
  const domain = { global: { get: () => value, set: async next => { sets++; value = next; } } };
  const store = await new TaskStore(new SingleDocumentBackend(domain)).open();
  const dispatcher = new Dispatcher({ store, adapters: {} });
  await dispatcher.update(() => {});
  assert.equal(sets, 0);
  await dispatcher.update(s => { s.tasks[0].report = 'pending'; s.tasks.push(task('b')); });
  assert.equal(sets, 1);
  assert.deepEqual(value.tasks.map(t => [t.id, t.report]), [['a', 'pending'], ['b', 'sent']]);
  assert.equal(value.paused, true); assert.equal(value.taskOrder, undefined);
});
