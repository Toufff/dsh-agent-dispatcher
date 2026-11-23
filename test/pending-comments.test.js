import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { MemoryStore } from '../src/dispatcher.js';
import { initialState } from '../src/config.js';
import { Runtime } from '../src/runtime.js';
import { workItems } from './workflow-fixtures.js';

const done = `<dispatch-result>${JSON.stringify({ status: 'complete', workItems: workItems('complete'), evidence: ['ok'], remaining: [], next: '', progress: 'done', blockers: [] })}</dispatch-result>`;
const at = () => new Date(Date.now() + 1000).toISOString();
const queued = (id, body) => ({ id, createdAt: new Date().toISOString(), body });

async function fixture({ comments = () => [], followup = {} } = {}) {
  const store = new MemoryStore(), state = initialState();
  state.paused = false;
  state.settings.projects = [{ id: 'p', label: 'Example', cwd: process.cwd(),
    linear: { enabled: true, tokenEnv: 'TEST_TOKEN', workspaceId: 'w', assigneeId: 'me', round: '1', reviewStateId: 'review' },
    followup: { enabled: true, commentAuthorIds: ['peer', 'me'], maxWakeups: 8, reviewComments: true, trustReceiverComments: true, ...followup } }];
  await store.save(state);
  const runtime = await new Runtime({ store, directory: os.tmpdir(), env: { TEST_TOKEN: 'synthetic' }, linearFactory: () => ({
    eligible: async () => ({}), activity: async () => ({ comments: comments() }) }) }).init();
  runtime.adapters.codex = { start: async () => ({ status: 'review', summary: done, sessionId: 'original-session' }) };
  await runtime.submit({ projectId: 'p', prompt: 'Work', issue: { id: 'issue', identifier: 'EX-1' }, source: 'w/issue' });
  await runtime.dispatcher.tick(); await runtime.assess();
  return runtime;
}
// A running round that was stopped with owner comments still queued (LON-160/212/213/215/216/218).
const stoppedWithComments = s => { const t = s.tasks[0]; t.status = 'stopped'; t.prompt = 'ROUND PROMPT';
  t.attempts = [{ id: 'r', executor: 'codex', status: 'stopped', accepted: true, sessionId: 'original-session' }];
  t.pendingComments = [queued('k1', 'owner：先重算主口径')]; t.followupSeen = ['k1'];
  t.events.push({ action: 'stop', at: new Date().toISOString() }); };

test('a retry hands the queued owner comments to the retried round exactly once', async () => {
  const runtime = await fixture();
  await runtime.dispatcher.update(stoppedWithComments);
  const id = (await runtime.snapshot()).tasks[0].id;
  await runtime.command({ action: 'retry', id });
  let t = (await runtime.snapshot()).tasks[0];
  assert.equal(t.status, 'queued');
  assert.match(t.prompt, /^ROUND PROMPT\n\nOWNER COMMENTS[\s\S]*先重算主口径/);
  assert.equal(t.pendingComments, undefined);
  assert.deepEqual(t.events.slice(-2).map(e => e.action), ['comment-delivered', 'retry']);
  // stopped and retried again: nothing is delivered twice
  await runtime.dispatcher.update(s => { s.tasks[0].status = 'stopped'; });
  await runtime.command({ action: 'retry', id });
  t = (await runtime.snapshot()).tasks[0];
  assert.equal(t.prompt.match(/OWNER COMMENTS/g).length, 1);
});

test('a retry in a fresh session (context over the limit) also takes the queued comments', async () => {
  const runtime = await fixture();
  runtime.adapters.codex.contextTokens = async () => 250000;
  await runtime.dispatcher.update(stoppedWithComments);
  await runtime.command({ action: 'retry', id: (await runtime.snapshot()).tasks[0].id });
  const t = (await runtime.snapshot()).tasks[0];
  assert.equal(t.session, undefined);
  assert.match(t.prompt, /^FRESH SESSION[\s\S]*ROUND PROMPT[\s\S]*OWNER COMMENTS[\s\S]*先重算主口径/);
  assert.equal(t.pendingComments, undefined);
});

test('retrying a format-repair round keeps the comments for the next working round', async () => {
  const runtime = await fixture();
  await runtime.dispatcher.update(s => { stoppedWithComments(s); const t = s.tasks[0]; t.prompt = 'repair only'; t.formatRepair = true;
    t.events.push({ action: 'repair-result', at: new Date().toISOString() }); });
  await runtime.command({ action: 'retry', id: (await runtime.snapshot()).tasks[0].id });
  const t = (await runtime.snapshot()).tasks[0];
  assert.equal(t.prompt, 'repair only');
  assert.deepEqual(t.pendingComments.map(c => c.id), ['k1']);
});

test('a stopped round with queued owner comments resumes on them automatically', async () => {
  let reads = 0;
  const runtime = await fixture({ comments: () => { reads++; return []; } });
  await runtime.dispatcher.update(stoppedWithComments);
  runtime.commentDue = () => false;           // no new comment on the issue: the queued ones are enough
  await runtime.reviewComments();
  const s = await runtime.snapshot(), next = s.tasks[1];
  assert.ok(next, 'continuation created');
  assert.equal(reads, 1, 'eligibility is still read');
  assert.equal(next.session.id, 'original-session');
  assert.match(next.prompt, /been stopped; the owner comment resumes it/);
  assert.equal(next.prompt.match(/先重算主口径/g).length, 1);
  assert.equal(s.tasks[0].pendingComments, undefined);
  assert.deepEqual(next.events.filter(e => e.action.startsWith('comment-')).map(e => [e.action, e.from]), [['comment-delivered', undefined], ['comment-resume', 'stopped']]);
  assert.deepEqual(next.followupSeen, ['k1']);
  // no second continuation from the same comments
  runtime.reviewCheckedAt.clear(); await runtime.reviewComments();
  assert.equal((await runtime.snapshot()).tasks.length, 2);
});

test('a stopped round without a confirmed session resumes in a fresh one', async () => {
  const runtime = await fixture();
  await runtime.dispatcher.update(s => { stoppedWithComments(s); const t = s.tasks[0]; t.attempts = []; delete t.session;
    t.previousAttempts = [{ id: 'old', executor: 'codex', status: 'stopped', accepted: true, sessionId: 'old-session' }]; });
  runtime.commentDue = () => false;
  await runtime.reviewComments();
  const next = (await runtime.snapshot()).tasks[1];
  assert.ok(next);
  assert.equal(next.session, undefined);
  assert.match(next.prompt, /FRESH SESSION: .*stopped without a confirmed session/);
});

test('an owner comment on a stalled chain resumes it (LON-35, 2026-11-23)', async () => {
  const later = at();
  const runtime = await fixture({ comments: () => [{ id: 'o1', body: 'owner：换个方向', createdAt: later, updatedAt: later, user: { id: 'me' } }] });
  await runtime.dispatcher.update(s => { const t = s.tasks[0]; t.status = 'stalled'; t.assessed = true; t.continuationStop = 'budget';
    t.events.push({ action: 'stalled', at: new Date().toISOString() }); });
  await runtime.reviewComments();
  const next = (await runtime.snapshot()).tasks[1];
  assert.ok(next, 'continuation created');
  assert.match(next.prompt, /stalled \(automatic continuation stopped\); the owner comment resumes it[\s\S]*换个方向/);
  assert.deepEqual(next.events.at(-1).action, 'comment-resume');
  assert.equal(next.events.at(-1).from, 'stalled');
});

test('a manual stop does not resume without an owner comment, and a human takeover never does', async () => {
  const runtime = await fixture();
  await runtime.dispatcher.update(s => { const t = s.tasks[0]; t.status = 'stopped'; t.events.push({ action: 'stop', at: new Date().toISOString() }); });
  await runtime.reviewComments();
  assert.equal((await runtime.snapshot()).tasks.length, 1);
  await runtime.dispatcher.update(s => { stoppedWithComments(s); s.tasks[0].owner = 'human'; s.tasks[0].status = 'manual'; });
  runtime.reviewCheckedAt.clear(); await runtime.reviewComments();
  assert.equal((await runtime.snapshot()).tasks.length, 1);
});

test('a manual continuation and a data wake carry the queued comments into the new round', async () => {
  const runtime = await fixture();
  await runtime.dispatcher.update(s => { const t = s.tasks[0]; t.pendingComments = [queued('k9', 'owner：补一个对照组')]; t.followupSeen = ['k9']; });
  await runtime.command({ action: 'continue', id: (await runtime.snapshot()).tasks[0].id, prompt: 'go on' });
  const s = await runtime.snapshot();
  assert.match(s.tasks[1].prompt, /OWNER COMMENTS[\s\S]*补一个对照组/);
  assert.equal(s.tasks[0].pendingComments, undefined);
  assert.equal(s.tasks[1].events.at(-1).action, 'comment-delivered');
});

test('a queued comment reaching a round that settled meanwhile stays queued for it', async () => {
  const later = at();
  const runtime = await fixture({ comments: () => [{ id: 'o2', body: 'owner：先停一下', createdAt: later, updatedAt: later, user: { id: 'me' } }] });
  await runtime.dispatcher.update(s => { const t = s.tasks[0]; t.status = 'running'; t.createdAt = new Date(Date.now() - 60000).toISOString();
    t.attempts = [{ id: 'r', executor: 'codex', status: 'running', accepted: true, sessionId: 'original-session' }]; });
  const state = await runtime.store.read();
  // the round settles while the comment read is in flight
  await runtime.dispatcher.update(s => { s.tasks[0].status = 'review'; s.tasks[0].assessed = true; });
  runtime.reviewCheckedAt ||= new Map(); runtime.commentDirty = new Set();
  await runtime.queueChainComments(state.tasks[0], state, new Set());
  assert.deepEqual((await runtime.snapshot()).tasks[0].pendingComments.map(c => c.id), ['o2']);
});
