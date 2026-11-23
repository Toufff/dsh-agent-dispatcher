import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { MemoryStore } from '../src/dispatcher.js';
import { initialState } from '../src/config.js';
import { Runtime } from '../src/runtime.js';
import { workItems } from './workflow-fixtures.js';

const done = `<dispatch-result>${JSON.stringify({ status: 'complete', workItems: workItems('complete'), evidence: ['ok'], remaining: [], next: '', progress: 'done', blockers: [] })}</dispatch-result>`;
const round = (n, at = new Date().toISOString()) => ({ at, body: `自动续办第 ${n} 轮已结束，下一轮已自动开始；以下是本轮结果。` });

async function fixture() {
  const store = new MemoryStore(), state = initialState();
  state.paused = false;
  state.settings.projects = [{ id: 'p', label: 'Example', cwd: process.cwd(),
    linear: { enabled: true, shareProgress: true, tokenEnv: 'TEST_TOKEN', workspaceId: 'w', assigneeId: 'me', round: '1', reviewStateId: 'review' },
    followup: { enabled: true, commentAuthorIds: ['peer'], maxWakeups: 8, reviewComments: true } }];
  await store.save(state);
  const linear = { down: false, sent: [] };
  const runtime = await new Runtime({ store, directory: os.tmpdir(), env: { TEST_TOKEN: 'synthetic' }, linearFactory: () => ({
    eligible: async () => ({}), activity: async () => ({ comments: [] }),
    report: async item => { if (linear.down) throw new Error('Linear down'); linear.sent.push(item); } }) }).init();
  runtime.adapters.codex = { start: async () => ({ status: 'review', summary: done, sessionId: 's' }) };
  await runtime.submit({ projectId: 'p', prompt: 'Work', issue: { id: 'issue', identifier: 'EX-1' }, source: 'w/issue' });
  await runtime.dispatcher.tick(); await runtime.assess();
  return { runtime, linear };
}
const digests = async runtime => (await runtime.store.load()).outbox.filter(i => i.roundReport);
const retryNow = runtime => runtime.dispatcher.update(s => { for (const i of s.outbox) delete i.nextAt; });

test('a settled chain\'s round digest survives a continuation started before Linear accepted it', async () => {
  const { runtime, linear } = await fixture();
  await runtime.dispatcher.update(s => { const t = s.tasks[0]; t.pendingRounds = [round(1), round(2)]; t.report = 'pending'; });
  linear.down = true;
  await runtime.report();
  assert.deepEqual((await digests(runtime)).map(i => i.status), ['pending']);
  await runtime.command({ action: 'continue', id: (await runtime.snapshot()).tasks[0].id, prompt: 'next' });
  assert.deepEqual((await digests(runtime)).map(i => i.status), ['pending'], 'not superseded by the continuation');
  linear.down = false; await retryNow(runtime);
  await runtime.report();
  assert.deepEqual((await digests(runtime)).map(i => i.status), ['sent']);
  assert.ok(linear.sent.some(i => i.roundReport && /自动续办 2 轮/.test(i.body)));
});

test('rounds collected on a task that a newer task replaced are flushed at once, not stranded', async () => {
  const { runtime, linear } = await fixture();
  await runtime.dispatcher.update(s => { const t = s.tasks[0]; t.status = 'stopped'; t.pendingRounds = [round(1)]; t.report = 'sent'; });
  // the same issue is taken again under a new round key: the old task stops being current without a hand-over
  await runtime.submit({ projectId: 'p', prompt: 'Work again', issue: { id: 'issue', identifier: 'EX-1' }, source: 'w/issue', round: '2' });
  await runtime.report();
  const [digest] = await digests(runtime);
  assert.equal(digest.status, 'sent');
  assert.equal((await runtime.snapshot()).tasks[0].pendingRounds, undefined);
  assert.ok(linear.sent.some(i => i.id === digest.id));
});

test('a pending round report is sent even when its task has left the hot state', async () => {
  const { runtime, linear } = await fixture();
  await runtime.dispatcher.update(s => { s.outbox.push({ id: 'rr', taskId: 'gone', projectId: 'p', roundReport: true, issueId: 'issue', body: 'digest', status: 'pending', tries: 0 }); });
  await runtime.report();
  assert.equal((await runtime.store.load()).outbox.find(i => i.id === 'rr').status, 'sent');
  assert.ok(linear.sent.some(i => i.id === 'rr'));
});
