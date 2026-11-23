import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { DshAdapter, askedQuestion } from '../src/adapters/dsh.js';
import { MemoryStore } from '../src/dispatcher.js';
import { initialState } from '../src/config.js';
import { Runtime } from '../src/runtime.js';

const admission = { type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, inserted: [{ id: 'm', source: { rpcId: 'attempt' } }] } };
const ask = { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Need a choice' },
  { type: 'tool_use', id: 'call-1', name: 'ask_user_question', input: { questions: [{ id: 'q1', header: '口径', question: '用哪个主口径？', options: [] }] } }] } } };
const attempt = { id: 'attempt', sessionId: 'session', status: 'running' };

function liveAgent() {
  const agent = { status: 'running', inbox: { nextTurn: [], nextStep: [] }, cancelled: 0,
    cancel() { agent.cancelled++; agent.status = 'idle'; }, whenIdle: async () => {} };
  return agent;
}

test('a DSH round blocked on ask_user_question is reported as needing input and its turn is cancelled', async () => {
  const agent = liveAgent();
  const adapter = new DshAdapter({ agents: { get: () => agent }, sessionController: {
    inspect: async () => ({ events: [admission, ask] }), state: async () => ({ running: true, pendingInput: ['question'] }) } });
  const result = await adapter.reconcile({ attempt });
  assert.equal(result.status, 'needs_input');
  assert.equal(result.reason, 'question');
  assert.equal(result.question, '口径：用哪个主口径？');
  assert.equal(result.cancelled, true);
  assert.equal(agent.cancelled, 1);
});

test('approvals, other inputs and hosts without the state API keep a running round running', async () => {
  for (const sessionController of [
    { inspect: async () => ({ events: [admission] }), state: async () => ({ pendingInput: ['approval'] }) },
    { inspect: async () => ({ events: [admission] }), state: async () => ({ pendingInput: [] }) },
    { inspect: async () => ({ events: [admission] }), state: async () => { throw new Error('unavailable'); } },
    { inspect: async () => ({ events: [admission] }) }]) {
    const agent = liveAgent();
    const adapter = new DshAdapter({ agents: { get: () => agent }, sessionController });
    assert.equal((await adapter.reconcile({ attempt })).status, 'running');
    assert.equal((await adapter.reconcile({ attempt })).status, 'running');
    assert.equal(agent.cancelled, 0);
  }
});

test('question text is read from the newest ask_user_question call in any common tool-call shape', () => {
  assert.equal(askedQuestion([{ type: 'x', data: { toolName: 'ask_user_question', args: JSON.stringify({ questions: [{ question: 'A?' }, { question: 'B?' }] }) } }]), 'A?\nB?');
  assert.equal(askedQuestion([ask, { type: 'tool/call', data: { call: { name: 'ask_user_question', arguments: { questions: [{ question: 'newer?' }] } } } }]), 'newer?');
  assert.equal(askedQuestion([{ type: 'assistant/message', data: { content: [] } }]), '');
});

test('a round waiting for an answer becomes a decision: reported, notified, and an owner answer continues it in the same session', async () => {
  const store = new MemoryStore(), state = initialState();
  state.paused = false;
  state.settings.projects = [{ id: 'p', label: 'Example', cwd: process.cwd(),
    linear: { enabled: true, shareProgress: true, tokenEnv: 'TEST_TOKEN', workspaceId: 'w', assigneeId: 'me', round: '1', reviewStateId: 'review', blockedStateId: 'blocked' },
    followup: { enabled: true, commentAuthorIds: ['peer', 'me'], maxWakeups: 8, reviewComments: true, trustReceiverComments: true } }];
  state.settings.notifications = { channels: [{ id: 'f', type: 'feishu', label: 'F', enabled: true, credentialsFile: process.cwd(), projectIds: ['p'] }] };
  await store.save(state);
  let comments = [];
  const runtime = await new Runtime({ store, directory: os.tmpdir(), env: { TEST_TOKEN: 'synthetic' }, linearFactory: () => ({
    eligible: async () => ({}), activity: async () => ({ comments }), report: async () => {} }) }).init();
  const starts = [];
  runtime.adapters.codex = { start: async ({ task, attempt }) => { starts.push({ prompt: task.prompt, attempt }); return { status: 'running', sessionId: 's1' }; },
    reconcile: async () => ({ status: 'needs_input', reason: 'question', question: '用哪个主口径？', cancelled: true }) };
  await runtime.submit({ projectId: 'p', prompt: 'Work', issue: { id: 'issue', identifier: 'EX-1' }, source: 'w/issue' });
  assert.match((await runtime.snapshot()).tasks[0].prompt, /UNATTENDED EXECUTION: .*Do not call ask_user_question/);
  await runtime.dispatcher.tick(); await runtime.dispatcher.reconcile(); await runtime.assess();
  let t = (await runtime.snapshot()).tasks[0];
  assert.equal(t.status, 'decision'); assert.equal(t.assessed, true);
  assert.equal(t.attempts[0].status, 'stopped');
  assert.equal(t.inputRequest.question, '用哪个主口径？');
  assert.match(t.outcome.blockers[0].reason, /用哪个主口径/);
  assert.equal(t.events.filter(e => e.action === 'input-required').length, 1);
  const { attention } = await import('../src/notifications.js');
  assert.ok([...attention(await runtime.store.read(), state.settings.notifications.channels[0]).values()].some(n => n.type === 'decision' && /用哪个主口径/.test(n.text)));
  await runtime.report();
  const report = (await runtime.store.load()).outbox.find(i => i.taskStatus === 'decision');
  assert.ok(report, 'decision written back');
  assert.match(report.body, /提出了问题[\s\S]*用哪个主口径/);
  assert.equal(report.stateId, 'blocked');
  // the owner answers in Linear: the next round resumes the same session with the answer
  const at = new Date(Date.now() + 1000).toISOString();
  comments = [{ id: 'a1', body: 'owner：用 A 口径', createdAt: at, updatedAt: at, user: { id: 'me' } }];
  await runtime.reviewComments();
  const next = (await runtime.snapshot()).tasks[1];
  assert.ok(next, 'continued');
  assert.equal(next.session.id, t.attempts[0].sessionId);
  assert.match(next.prompt, /用 A 口径/);
});
