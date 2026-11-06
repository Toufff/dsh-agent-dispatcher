import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { MemoryStore } from '../src/dispatcher.js';
import { initialState, settingsSchema } from '../src/config.js';
import { Runtime } from '../src/runtime.js';
import { workItems } from './workflow-fixtures.js';

const done = `<dispatch-result>${JSON.stringify({ status: 'complete', workItems: workItems('complete'), evidence: ['ok'], remaining: [], next: '', progress: 'done', blockers: [] })}</dispatch-result>`;

async function fixture({ comments = [], eligible = true, followup = {} } = {}) {
  const store = new MemoryStore(), state = initialState();
  state.paused = false;
  state.settings.projects = [{ id: 'p', label: 'Example', cwd: process.cwd(),
    linear: { enabled: true, tokenEnv: 'TEST_TOKEN', workspaceId: 'w', assigneeId: 'me', round: '1', reviewStateId: 'review' },
    followup: { enabled: true, commentAuthorIds: ['peer', 'me'], maxWakeups: 8, reviewComments: true, ...followup } }];
  await store.save(state);
  const calls = { activity: 0 };
  const runtime = await new Runtime({ store, directory: os.tmpdir(), env: { TEST_TOKEN: 'synthetic' }, linearFactory: () => ({
    eligible: async () => ({}),
    activity: async () => { calls.activity++; if (!eligible) throw new Error('closed'); return { comments: comments() }; }
  }) }).init();
  const starts = [];
  runtime.adapters.codex = { start: async task => { starts.push(task); return { status: 'review', summary: done, sessionId: 'original-session' }; } };
  await runtime.submit({ projectId: 'p', prompt: 'Work', issue: { id: 'issue', identifier: 'EX-1' }, source: 'w/issue' });
  await runtime.dispatcher.tick(); await runtime.assess();
  return { runtime, calls, starts };
}
const later = () => new Date(Date.now() + 1000).toISOString();

test('schema accepts the review comment switch', () => {
  const settings = initialState().settings;
  settings.projects = [{ id: 'p', label: 'P', cwd: process.cwd(), followup: { enabled: true, commentAuthorIds: [], reviewComments: true } }];
  assert.equal(settingsSchema.parse(settings).projects[0].followup.reviewComments, true);
});

test('a trusted comment after completion continues in the original session once', async () => {
  const at = later();
  const list = [{ id: 'c1', body: 'please dig further', createdAt: at, updatedAt: at, user: { id: 'peer' } },
    { id: 'c2', body: 'own report', createdAt: at, updatedAt: at, user: { id: 'me' } }];
  const { runtime, starts } = await fixture({ comments: () => list });
  assert.equal((await runtime.snapshot()).tasks[0].status, 'review');
  await runtime.reviewComments();
  let state = await runtime.snapshot();
  assert.equal(state.tasks.length, 2);
  const next = state.tasks[1];
  assert.equal(next.session.id, 'original-session');
  assert.equal(next.reviewWakeups, 1);
  assert.deepEqual(next.followupSeen, ['c1']);
  assert.match(next.prompt, /please dig further/);
  assert.doesNotMatch(next.prompt, /own report/);
  // Same comment is never consumed twice, even after the continuation finishes.
  await runtime.dispatcher.tick(); await runtime.assess();
  assert.equal(starts.length, 2);
  runtime.reviewCheckedAt.clear();
  await runtime.reviewComments();
  state = await runtime.snapshot();
  assert.equal(state.tasks.length, 2);
  assert.equal(state.tasks[1].status, 'review');
});

test('no continuation for old comments, untrusted authors, closed issues, disabled switch or pause', async () => {
  const old = new Date(Date.now() - 60000).toISOString(), at = later();
  for (const options of [
    { comments: () => [{ id: 'c', body: 'x', createdAt: old, updatedAt: old, user: { id: 'peer' } }] },
    { comments: () => [{ id: 'c', body: 'x', createdAt: at, updatedAt: at, user: { id: 'stranger' } }] },
    { comments: () => [{ id: 'c', body: 'x', createdAt: at, updatedAt: at, user: { id: 'peer' } }], eligible: false },
    { comments: () => [{ id: 'c', body: 'x', createdAt: at, updatedAt: at, user: { id: 'peer' } }], followup: { reviewComments: false } }
  ]) {
    const { runtime } = await fixture(options);
    await runtime.reviewComments();
    assert.equal((await runtime.snapshot()).tasks.length, 1);
  }
  const { runtime, calls } = await fixture({ comments: () => [{ id: 'c', body: 'x', createdAt: at, updatedAt: at, user: { id: 'peer' } }] });
  await runtime.command({ action: 'pause' });
  await runtime.reviewComments();
  assert.equal(calls.activity, 0);
  assert.equal((await runtime.snapshot()).tasks.length, 1);
});

test('checks are throttled and stop at the wake-up limit', async () => {
  let n = 0;
  const { runtime, calls } = await fixture({ followup: { maxWakeups: 1 },
    comments: () => { const at = later(); return [{ id: `c${n++}`, body: 'more', createdAt: at, updatedAt: at, user: { id: 'peer' } }]; } });
  await runtime.reviewComments();
  await runtime.dispatcher.tick(); await runtime.assess();
  runtime.reviewCheckedAt.clear();
  await runtime.reviewComments();
  const state = await runtime.snapshot();
  assert.equal(state.tasks.length, 2);
  assert.equal(calls.activity, 1);
});
