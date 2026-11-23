import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DshAdapter } from '../src/adapters/dsh.js';
import { Dispatcher, MemoryStore } from '../src/dispatcher.js';

const admission = { type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, inserted: [{ id: 'm', source: { rpcId: 'attempt' } }] } };
const attempt = { id: 'attempt', sessionId: 'session', status: 'running' };

test('a running DSH round is confirmed from durable history once, then answered from the live Agent', async () => {
  let inspections = 0;
  const events = [admission];
  const agent = { status: 'running', inbox: { nextTurn: [], nextStep: [] } };
  const adapter = new DshAdapter({ agents: { get: () => agent }, sessionController: { inspect: async () => { inspections++; return { events }; } } });
  for (let i = 0; i < 5; i++) assert.equal((await adapter.reconcile({ attempt })).status, 'running');
  assert.equal(inspections, 1);
  // the turn ends: the next pass reads history again and returns the receipt
  agent.status = 'idle';
  events.push({ type: 'assistant/message', data: { content: [{ type: 'text', text: 'Result' }] } }, { type: 'turn/end', data: { reason: { kind: 'completed' } } });
  const result = await adapter.reconcile({ attempt });
  assert.equal(result.status, 'review'); assert.equal(result.summary, 'Result');
  assert.equal(inspections, 2);
});

test('a prompt still queued in the live inbox needs no history read; an unconfirmed admission still does', async () => {
  let inspections = 0;
  const queued = { status: 'running', inbox: { nextTurn: [{ id: 'm', source: { rpcId: 'attempt' } }], nextStep: [] } };
  let adapter = new DshAdapter({ agents: { get: () => queued }, sessionController: { inspect: async () => { inspections++; return { events: [admission] }; } } });
  assert.equal((await adapter.reconcile({ attempt })).status, 'running');
  assert.equal(inspections, 0);
  // A running Agent busy with something else, without our admission in history, stays unknown.
  const other = { status: 'running', inbox: { nextTurn: [], nextStep: [] } };
  adapter = new DshAdapter({ agents: { get: () => other }, sessionController: { inspect: async () => { inspections++; return { events: [] }; } } });
  assert.equal((await adapter.reconcile({ attempt })).status, 'unknown');
  assert.equal((await adapter.reconcile({ attempt })).status, 'unknown');
  assert.equal(inspections, 2);
});

test('reconcile hands the adapter the attempt and a small task view, not the task history', async () => {
  const store = new MemoryStore();
  await store.save({ tasks: [], settings: { executors: [], projects: [] } });
  const seen = [];
  const dispatcher = new Dispatcher({ store, adapters: { first: { start: async () => ({ status: 'running' }),
    reconcile: async context => { seen.push(context); return { status: 'running' }; } } } });
  await dispatcher.enqueue({ source: 's', round: '1', prompt: 'x'.repeat(100000), executors: ['first'], cwd: '/work' });
  await dispatcher.update(state => { state.tasks[0].rounds = [{ summary: 'y'.repeat(100000) }]; });
  await dispatcher.tick(); await dispatcher.reconcile();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].attempt.status, 'running');
  assert.equal(seen[0].task.cwd, '/work');
  assert.equal(seen[0].task.prompt, undefined); assert.equal(seen[0].task.rounds, undefined); assert.equal(seen[0].task.events, undefined);
});
