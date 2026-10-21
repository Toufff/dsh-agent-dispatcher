import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DshAdapter } from '../src/adapters/dsh.js';

test('cold DSH sessions with pending inbox work cannot be returned to automation', async () => {
  const events = [{ type: 'turn/end', data: {} }, { type: 'agent/inbox/spliced', data: {
    target: 'nextTurn', start: 0, removedCount: 0, inserted: [{ id: 'human-pending' }]
  } }];
  const adapter = new DshAdapter({ agents: { get: () => undefined }, sessionController: { inspect: async () => ({ events }) } });
  const context = { attempt: { sessionId: 'session' } };
  assert.equal(await adapter.idle(context), false);
  events.push({ type: 'agent/inbox/spliced', data: { target: 'nextTurn', start: 0, removedCount: 1, inserted: [] } });
  assert.equal(await adapter.idle(context), true);
});

test('DSH clears only dispatcher-owned queued prompts before cancellation', async () => {
  const events = [], owned = { id: 'owned', source: { rpcId: 'attempt' } }, manual = { id: 'human', source: { rpcId: 'other' } };
  const inbox = { nextTurn: [owned, manual], nextStep: [], remove(id) { events.push(`remove:${id}`); this.nextTurn = this.nextTurn.filter(m => m.id !== id); } };
  const agent = { inbox, cancel(cause, options) { events.push('cancel'); assert.equal(options.keepInbox, true); }, whenIdle: async () => {} };
  const adapter = new DshAdapter({ agents: { get: () => agent } });
  const result = await adapter.stop({ attempt: { id: 'attempt', sessionId: 'session' } });
  assert.equal(result.status, 'stopped'); assert.deepEqual(events, ['remove:owned', 'cancel']);
  assert.deepEqual(inbox.nextTurn, [manual]);
});
test('DSH resume refuses a different workspace and waits for busy sessions', async () => {
  const task = { cwd: process.cwd() }, attempt = { id: 'attempt', sessionId: 'session', resume: true };
  const ctx = { sessionController: { inspect: async () => ({ meta: { cwd: '/different' } }) } };
  assert.equal((await new DshAdapter(ctx).start({ task, attempt })).status, 'rejected');
  ctx.sessionController.inspect = async () => ({ meta: { cwd: process.cwd() } });
  ctx.sessionController.resolveAgent = async () => ({ agent: { status: 'running', inbox: { nextTurn: [], nextStep: [] } } });
  assert.equal((await new DshAdapter(ctx).start({ task, attempt })).status, 'busy');
});
test('DSH missing admission evidence stays unknown even if another turn completed', async () => {
  const adapter = new DshAdapter({ agents: { get: () => undefined }, sessionController: {
    inspect: async () => ({ events: [{ type: 'turn/end', data: { reason: { kind: 'completed' } } }] })
  } });
  assert.equal((await adapter.reconcile({ attempt: { id: 'absent', sessionId: 'session' } })).status, 'unknown');
});
