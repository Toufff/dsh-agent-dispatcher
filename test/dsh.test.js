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

// DSH 0.2.2 removed sessionController.inspect; history comes from paged `events` records.
const page = (events, hasMore, cursor) => ({ cursor, hasMore, records: events.map(event => ({ type: 'event', event })) });
const seqd = list => list.map((e, seq) => ({ seq, ...e }));

test('DSH 0.2.2: cold history is read across pages at one fixed cut, oldest first', async () => {
  const all = seqd([
    { type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, inserted: [{ id: 'm', source: { rpcId: 'attempt' } }] } },
    { type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [] } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Mined result' }] } } },
    { type: 'turn/end', data: { reason: { kind: 'completed' } } }
  ]);
  const calls = [];
  const sessionController = { events: async request => {
    calls.push(request);
    // two-event pages, newest first, like DSH's backward pagination
    const end = Math.min((request.throughSeq ?? all.length - 1) + 1, request.beforeSeq ?? Infinity);
    const startAt = Math.max(0, end - 2);
    return page(all.slice(startAt, end), startAt > 0, request.throughSeq ?? all.length - 1);
  } };
  const adapter = new DshAdapter({ agents: { get: () => undefined }, sessionController });
  const result = await adapter.reconcile({ attempt: { id: 'attempt', sessionId: 'session' } });
  assert.equal(result.status, 'review'); assert.equal(result.summary, 'Mined result');
  assert.deepEqual(calls.map(c => [c.address.sessionId, c.throughSeq, c.beforeSeq]), [['session', undefined, undefined], ['session', 3, 2]]);
  assert.equal(await adapter.idle({ attempt: { sessionId: 'session' } }), true);
});

test('DSH 0.2.2: a running live session is read from its in-memory snapshot', async () => {
  let historyReads = 0;
  const snapshot = seqd([{ type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, inserted: [{ id: 'm', source: { rpcId: 'attempt' } }] } }]);
  const agent = { status: 'running', inbox: { nextTurn: [], nextStep: [] }, session: { header: { cwd: '/work' }, snapshotEvents: () => snapshot } };
  const adapter = new DshAdapter({ agents: { get: () => agent }, sessionController: { events: async () => { historyReads++; return page([], false, -1); } } });
  assert.equal((await adapter.reconcile({ attempt: { id: 'attempt', sessionId: 'session' } })).status, 'running');
  assert.equal(historyReads, 0);
});

test('DSH 0.2.2: an omitted removedCount is a pure insertion, so pending human work still blocks return', async () => {
  const events = seqd([{ type: 'turn/end', data: {} },
    { type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, inserted: [{ id: 'human-pending' }] } }]);
  const adapter = new DshAdapter({ agents: { get: () => undefined }, sessionController: { events: async () => page(events, false, 1) } });
  assert.equal(await adapter.idle({ attempt: { sessionId: 'session' } }), false);
});

test('DSH 0.2.2: resume checks the session directory from the session list', async () => {
  const task = { cwd: process.cwd() }, attempt = { id: 'attempt', sessionId: 'session', resume: true };
  const ctx = { agents: { get: () => undefined }, sessionController: {
    events: async () => page([], false, -1),
    list: async () => ({ items: [{ sessionId: 'session', cwd: '/different' }] }) } };
  assert.equal((await new DshAdapter(ctx).start({ task, attempt })).status, 'rejected');
  ctx.sessionController.list = async () => ({ items: [{ sessionId: 'session', cwd: process.cwd() }] });
  ctx.sessionController.resolveAgent = async () => ({ agent: { status: 'running', inbox: { nextTurn: [], nextStep: [] } } });
  assert.equal((await new DshAdapter(ctx).start({ task, attempt })).status, 'busy');
});

test('DSH 0.2.2: history that does not advance fails instead of looping', async () => {
  const stuck = seqd([{ type: 'user/message', data: {} }, { type: 'user/message', data: {} }]);
  const adapter = new DshAdapter({ agents: { get: () => undefined }, sessionController: { events: async () => page(stuck, true, 1) } });
  assert.equal((await adapter.reconcile({ attempt: { id: 'a', sessionId: 'session' } }).catch(e => ({ status: 'threw', e }))).status, 'threw');
});

test('DSH receipt uses its first completed turn, not a later unrelated session result', async () => {
 const events=[
  {type:'agent/inbox/spliced',data:{inserted:[{source:{rpcId:'attempt'}}]}},
  {type:'assistant/message',data:{content:[{type:'text',text:'Owned result'}]}},
  {type:'turn/end',data:{reason:{kind:'completed'}}},
  {type:'assistant/message',data:{content:[{type:'text',text:'Unrelated result'}]}},
  {type:'turn/end',data:{reason:{kind:'failed'}}}
 ];
 const adapter=new DshAdapter({agents:{get:()=>undefined},sessionController:{inspect:async()=>({events})}});
 const result=await adapter.reconcile({attempt:{id:'attempt',sessionId:'session'}});
 assert.equal(result.status,'review');assert.equal(result.summary,'Owned result');
});
