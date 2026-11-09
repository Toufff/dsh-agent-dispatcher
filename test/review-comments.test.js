import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { MemoryStore } from '../src/dispatcher.js';
import { initialState, settingsSchema } from '../src/config.js';
import { Runtime } from '../src/runtime.js';
import { workItems } from './workflow-fixtures.js';
import { inspectOutcome } from '../src/outcome.js';
import { ledgerPrompt } from '../src/workflow.js';

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

test('an external "decision" stage is classified as blocked, a permission decision is not', () => {
  const contract = (kind) => `<dispatch-result>${JSON.stringify({ status: 'decision', evidence: ['ok'], remaining: ['pick a path'], next: '', progress: 'x',
    blockers: [{ owner: 'owner', reason: 'choose', resumeWhen: 'reply' }],
    workItems: [{ id: 'a', title: 'done', status: 'done', dependsOn: [], action: '', evidence: ['e'] },
      { id: 'b', title: 'next', status: 'decision', dependsOn: ['a'], action: '', evidence: [],
        blocker: { kind, owner: 'owner', reason: 'choose', resumeWhen: 'reply' } }] })}</dispatch-result>`;
  const external = inspectOutcome(contract('external'), { required: true });
  assert.equal(external.error, null);
  assert.equal(external.outcome.status, 'blocked');
  assert.equal(external.outcome.workItems[1].status, 'blocked');
  assert.equal(external.framingRecovery, 'external-decision-as-blocked');
  const permission = inspectOutcome(contract('permission'), { required: true });
  assert.equal(permission.outcome.status, 'decision');
  assert.equal(permission.framingRecovery, undefined);
});

test('blocked and unclassified rounds continue on trusted comments; live waits are left to the monitor', async () => {
  const at = later();
  const list = () => [{ id: 'c1', body: 'pick (a)', createdAt: at, updatedAt: at, user: { id: 'peer' } }];
  for (const [status, wait, expected] of [['blocked', undefined, 2], ['needs_result', undefined, 2], ['decision', undefined, 2],
    ['blocked', { status: 'watching' }, 1]]) {
    const { runtime } = await fixture({ comments: list });
    await runtime.dispatcher.update(s => { s.tasks[0].status = status; if (wait) s.tasks[0].wait = wait; });
    await runtime.reviewComments();
    assert.equal((await runtime.snapshot()).tasks.length, expected, `${status} ${wait?.status || ''}`);
  }
});

test('a long follow-up ledger beyond 40 stages still validates', () => {
  const items = Array.from({ length: 120 }, (_, i) => ({ id: `s${i}`, title: `stage ${i}`, status: 'done', dependsOn: [], action: '', evidence: ['e'] }));
  items.push({ id: 'next', title: 'next', status: 'ready', dependsOn: [], action: 'do it', evidence: [] });
  const result = inspectOutcome(`<dispatch-result>${JSON.stringify({ status: 'continue', evidence: ['ok'], remaining: ['next'], next: 'do it', progress: 'x', blockers: [], workItems: items })}</dispatch-result>`, { required: true });
  assert.equal(result.error, null);
  assert.equal(result.outcome.status, 'continue');
});

test('the dispatcher keeps completed stages; a round reports only open and new items', () => {
  const previous = [
    ...Array.from({ length: 150 }, (_, i) => ({ id: `s${i}`, title: `stage ${i}`, status: 'done', dependsOn: [], action: '', evidence: ['e'] })),
    { id: 'open', title: 'open stage', status: 'ready', dependsOn: ['s3'], action: 'do it', evidence: [] }];
  const round = items => `<dispatch-result>${JSON.stringify({ status: 'continue', evidence: ['ok'], remaining: ['more'], next: 'next step', progress: 'x', blockers: [], workItems: items })}</dispatch-result>`;
  // Completed history omitted: restored in order, new item appended, references to omitted IDs resolve.
  const result = inspectOutcome(round([
    { id: 'open', title: 'open stage', status: 'done', dependsOn: ['s3'], action: '', evidence: ['verified'] },
    { id: 'new', title: 'new stage', status: 'ready', dependsOn: ['s149'], action: 'next step', evidence: [] }]), { previous, required: true });
  assert.equal(result.error, null);
  assert.equal(result.outcome.workItems.length, 152);
  assert.deepEqual(result.outcome.workItems.slice(-2).map(i => [i.id, i.status]), [['open', 'done'], ['new', 'ready']]);
  // Dropping an unfinished stage is still rejected.
  const dropped = inspectOutcome(round([{ id: 'new', title: 'new stage', status: 'ready', dependsOn: [], action: 'next step', evidence: [] }]), { previous, required: true });
  assert.match(dropped.error, /unfinished/);
  // Reopening a completed stage is still rejected.
  const replay = inspectOutcome(round([{ id: 's1', title: 'stage 1', status: 'ready', dependsOn: [], action: 'redo', evidence: [] },
    { id: 'open', title: 'open stage', status: 'ready', dependsOn: ['s3'], action: 'do it', evidence: [] }]), { previous, required: true });
  assert.match(replay.error, /replay/);
});

test('prompt ledger shows open items in full and completed items as a bounded index', () => {
  const items = [...Array.from({ length: 100 }, (_, i) => ({ id: `s${i}`, title: `stage ${i}`, status: 'done', dependsOn: [], action: '', evidence: ['long evidence '.repeat(20)] })),
    { id: 'open', title: 'open stage', status: 'ready', dependsOn: [], action: 'do it', evidence: [] }];
  const text = ledgerPrompt(items);
  assert.match(text, /"id":"open"/);
  assert.match(text, /- s99: stage 99/);
  assert.doesNotMatch(text, /- s0: /);
  assert.match(text, /60 older ones/);
  assert.doesNotMatch(text, /long evidence/);
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
