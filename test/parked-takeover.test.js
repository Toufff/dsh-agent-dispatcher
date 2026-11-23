import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Dispatcher, MemoryStore } from '../src/dispatcher.js';

const setup = async () => {
  const store = new MemoryStore();
  await store.save({ tasks: [], settings: { concurrency: 10, executors: [], projects: [] } });
  let starts = 0;
  const dispatcher = new Dispatcher({ store, adapters: { first: {
    start: async () => { starts++; return { status: 'running' }; },
    stop: async () => ({ status: 'stopped' }), idle: async () => true } } });
  const enqueue = async n => { await dispatcher.enqueue({ source: `w/issue-${n}`, round: '1', prompt: 'p', executors: ['first'], cwd: '/work/shared' });
    return (await store.load()).tasks.at(-1); };
  return { store, dispatcher, enqueue, starts: () => starts };
};

test('taking over an already stopped task only parks it and does not block other work in the same directory', async () => {
  const { store, dispatcher, enqueue, starts } = await setup();
  const parent = await enqueue(1);
  await dispatcher.tick();
  await dispatcher.action(parent.id, 'stop');
  await dispatcher.action(parent.id, 'takeover');
  let t = (await store.load()).tasks.find(x => x.id === parent.id);
  assert.equal(t.status, 'manual'); assert.equal(t.owner, 'human'); assert.equal(t.manualParked, true);
  await enqueue(2);
  await dispatcher.tick();
  assert.equal(starts(), 2, 'the second task in the same cwd starts');
  await dispatcher.action(parent.id, 'return', { confirmedIdle: true });
  t = (await store.load()).tasks.find(x => x.id === parent.id);
  assert.equal(t.owner, 'scheduler'); assert.equal(t.manualParked, undefined);
});

test('taking over a running round still pauses automatic work in that directory', async () => {
  const { store, dispatcher, enqueue, starts } = await setup();
  const live = await enqueue(1);
  await dispatcher.tick();
  await dispatcher.action(live.id, 'takeover');
  assert.equal((await store.load()).tasks.find(x => x.id === live.id).manualParked, false);
  await enqueue(2);
  await dispatcher.tick();
  assert.equal(starts(), 1, 'a person holds the live session in that cwd');
});
