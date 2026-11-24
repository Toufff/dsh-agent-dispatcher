import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { MemoryStore } from '../src/dispatcher.js';
import { initialState, settingsSchema } from '../src/config.js';
import { Runtime } from '../src/runtime.js';
import { workItems } from './workflow-fixtures.js';
import { inspectOutcome } from '../src/outcome.js';
import { ledgerPrompt } from '../src/workflow.js';
import { LinearClient } from '../src/linear.js';

const done = `<dispatch-result>${JSON.stringify({ status: 'complete', workItems: workItems('complete'), evidence: ['ok'], remaining: [], next: '', progress: 'done', blockers: [] })}</dispatch-result>`;

async function fixture({ comments = [], eligible = true, followup = {} } = {}) {
  const store = new MemoryStore(), state = initialState();
  state.paused = false;
  state.settings.projects = [{ id: 'p', label: 'Example', cwd: process.cwd(),
    linear: { enabled: true, tokenEnv: 'TEST_TOKEN', workspaceId: 'w', assigneeId: 'me', round: '1', reviewStateId: 'review' },
    followup: { enabled: true, commentAuthorIds: ['peer', 'me'], maxWakeups: 8, reviewComments: true, ...followup } }];
  await store.save(state);
  const calls = { activity: 0 };
  const runtime = await new Runtime({ store, commentSweepMs: 0, directory: os.tmpdir(), env: { TEST_TOKEN: 'synthetic' }, linearFactory: () => ({
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

test('with trustReceiverComments an owner comment from the receiver account ends a live wait and drops its window', async () => {
  const settledAt = new Date(Date.now() - 10000).toISOString(), at = later();
  const wait = () => ({ id: 'w1', kind: 'time', status: 'watching', condition: '等今晚数据', notBefore: new Date(Date.now() + 3600e3).toISOString(), armedAt: settledAt });
  const cases = [
    [{ trustReceiverComments: true }, { id: 'o1', body: 'owner：别等了，先做别的', user: { id: 'me' } }, 2],
    [{ trustReceiverComments: true }, { id: 'o2', body: '不带标记但在本轮结束后', user: { id: 'me' } }, 2],
    [{ trustReceiverComments: true }, { id: 'o3', body: 'ZRSTUDIO：本机回写', user: { id: 'me' } }, 1],
    [{ trustReceiverComments: true }, { id: 'p1', body: 'peer reply is the monitor\'s job', user: { id: 'peer' } }, 1],
    [{}, { id: 'o4', body: 'owner：别等了', user: { id: 'me' } }, 1]];
  for (const [followup, comment, expected] of cases) {
    const { runtime } = await fixture({ followup, comments: () => [{ ...comment, createdAt: at, updatedAt: at }] });
    await runtime.dispatcher.update(s => { const t = s.tasks[0]; t.createdAt = new Date(Date.now() - 60000).toISOString();
      t.status = 'blocked'; t.wait = wait(); t.events.push({ action: 'blocked', at: settledAt }); });
    await runtime.reviewComments();
    const state = await runtime.snapshot();
    assert.equal(state.tasks.length, expected, comment.body);
    if (expected === 2) {
      const next = state.tasks[1];
      assert.equal(next.resumeWindow, undefined);
      assert.equal(next.timingRevision.mode, 'recheck');
      assert.match(next.prompt, /ends that wait/);
      assert.equal(state.tasks[0].wait.status, 'superseded');
    }
  }
});

test('a dependency on a never-recorded stage is dropped; a real cycle is still rejected', () => {
  const previous = [{ id: 'old', title: 'old stage', status: 'done', dependsOn: [], action: '', evidence: ['e'] }];
  const round = items => `<dispatch-result>${JSON.stringify({ status: 'continue', evidence: ['ok'], remaining: ['more'], next: 'next step', progress: 'x', blockers: [], workItems: items })}</dispatch-result>`;
  const result = inspectOutcome(round([
    { id: 'next', title: 'next', status: 'ready', dependsOn: ['old', 'renamed-away'], action: 'do it', evidence: [] }]), { previous, required: true });
  assert.equal(result.error, null);
  assert.deepEqual(result.outcome.workItems.find(i => i.id === 'next').dependsOn, ['old']);
  assert.match(result.framingRecovery, /unknown-dependencies-dropped/);
  const cyclic = inspectOutcome(round([
    { id: 'a', title: 'a', status: 'ready', dependsOn: ['b'], action: 'x', evidence: [] },
    { id: 'b', title: 'b', status: 'ready', dependsOn: ['a'], action: 'y', evidence: [] }]), { previous, required: true });
  assert.match(cyclic.error, /cycles/);
});

test('a continue round with a wait keeps going and drops the wait; complete with a wait is still rejected', () => {
  const item = status => ({ id: 'x', title: 'x', status, dependsOn: [], action: status === 'ready' ? 'do it' : '', evidence: status === 'done' ? ['e'] : [] });
  const wait = { kind: 'time', condition: 'tomorrow snapshot', notBefore: new Date(Date.now() + 864e5).toISOString() };
  const frame = body => `<dispatch-result>${JSON.stringify(body)}</dispatch-result>`;
  const kept = inspectOutcome(frame({ status: 'continue', evidence: ['ok'], remaining: ['more'], next: 'next', progress: 'x', blockers: [], workItems: [item('ready')], wait }), { required: true });
  assert.equal(kept.error, null);
  assert.equal(kept.outcome.wait, undefined);
  assert.match(kept.framingRecovery, /continue-wait-dropped/);
  const done = inspectOutcome(frame({ status: 'complete', evidence: ['ok'], remaining: [], next: '', progress: 'x', blockers: [], workItems: [item('done')], wait }), { required: true });
  assert.match(done.error, /may include wait/);
});

test('a result that omits workItems keeps the stored ledger instead of being rejected', () => {
  const previous = [{ id: 'done1', title: 'd', status: 'done', dependsOn: [], action: '', evidence: ['e'] },
    { id: 'next', title: 'n', status: 'ready', dependsOn: ['done1'], action: 'do it', evidence: [] }];
  const frame = body => `<dispatch-result>${JSON.stringify(body)}</dispatch-result>`;
  const r = inspectOutcome(frame({ status: 'continue', evidence: ['ok'], remaining: ['next'], next: 'do it', progress: 'x', blockers: [] }), { previous, required: true });
  assert.equal(r.error, null);
  assert.deepEqual(r.outcome.workItems.map(i => i.id), ['done1', 'next']);
  assert.match(r.framingRecovery, /ledger-reused/);
  const none = inspectOutcome(frame({ status: 'continue', evidence: ['ok'], remaining: ['next'], next: 'do it', progress: 'x', blockers: [] }), { previous: [], required: true });
  assert.match(none.error, /workItems/);
});

test('after a result without workItems the next round is told to report the ledger', async () => {
  const { runtime, starts } = await fixture();
  const ledger = [{ id: 'a', title: 'a', status: 'done', dependsOn: [], action: '', evidence: ['e'] },
    { id: 'b', title: 'b', status: 'ready', dependsOn: ['a'], action: 'do b', evidence: [] }];
  const noLedger = `<dispatch-result>${JSON.stringify({ status: 'continue', evidence: ['ok'], remaining: ['b'], next: 'do b', progress: 'new progress', blockers: [] })}</dispatch-result>`;
  await runtime.dispatcher.update(s => { const t = s.tasks[0]; t.workItems = ledger; t.status = 'review'; t.assessed = false; t.summary = noLedger; t.workflowVersion = 2; });
  await runtime.assess();
  const t = (await runtime.snapshot()).tasks[0];
  assert.equal(t.status, 'queued');
  assert.match(t.prompt, /omitted the REQUIRED workItems ledger/);
  assert.match(t.prompt, /still-open ids include b/);
  assert.ok(starts.length >= 1);
});

test('with freshRescue a twice-rejected result hands the task to a fresh session once', async () => {
  const { runtime } = await fixture({ followup: { freshRescue: true } });
  const ledger = [{ id: 'a', title: 'a', status: 'done', dependsOn: [], action: '', evidence: ['e'] },
    { id: 'b', title: 'b', status: 'ready', dependsOn: ['a'], action: 'do b', evidence: [] }];
  const bad = `<dispatch-result>${JSON.stringify({ status: 'continue', evidence: ['ok'], remaining: ['b'], next: 'do b', progress: 'p', blockers: [],
    workItems: [{ id: 'c', title: 'c', status: 'ready', dependsOn: ['b'], action: 'c', evidence: [] }, { ...ledger[1], dependsOn: ['c'] }] })}</dispatch-result>`;
  await runtime.dispatcher.update(s => { const t = s.tasks[0]; t.workItems = ledger; t.workflowVersion = 2; t.status = 'review'; t.assessed = false; t.summary = bad; t.formatRepair = true; });
  await runtime.assess();
  let t = (await runtime.snapshot()).tasks[0];
  assert.equal(t.status, 'queued');
  assert.equal(t.session, undefined);
  assert.match(t.prompt, /FRESH SESSION/);
  assert.equal(t.events.at(-1).action, 'fresh-session');
  // a second rejection in the same episode is left for a human
  await runtime.dispatcher.update(s => { const x = s.tasks[0]; x.status = 'review'; x.assessed = false; x.summary = bad; x.formatRepair = true;
    x.attempts = [{ id: 'z', executor: 'codex', status: 'review', accepted: true, sessionId: 'new-session' }]; });
  await runtime.assess();
  t = (await runtime.snapshot()).tasks[0];
  assert.equal(t.status, 'needs_result');
});

test('maxSessionRounds rotates a long automatic chain into a fresh session', async () => {
  const { runtime } = await fixture({ followup: { maxSessionRounds: 5 } });
  const ledger = [{ id: 'a', title: 'a', status: 'ready', dependsOn: [], action: 'do a', evidence: [] }];
  const good = `<dispatch-result>${JSON.stringify({ status: 'continue', evidence: ['ok'], remaining: ['a'], next: 'do a', progress: 'new p',
    blockers: [], workItems: [{ id: 'a', title: 'a', status: 'ready', dependsOn: [], action: 'do a', evidence: ['fresh evidence'] }] })}</dispatch-result>`;
  await runtime.dispatcher.update(s => { const t = s.tasks[0]; t.workItems = ledger; t.workflowVersion = 2; t.status = 'review'; t.assessed = false; t.summary = good; t.sessionRounds = 5; });
  await runtime.assess();
  const t = (await runtime.snapshot()).tasks[0];
  assert.equal(t.session, undefined);
  assert.equal(t.sessionRounds, 0);
  assert.match(t.prompt, /one session has run 5 automatic rounds/);
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
  // An omitted unfinished stage is kept open with its stored state, not dropped and not a rejection.
  const omitted = inspectOutcome(round([{ id: 'new', title: 'new stage', status: 'ready', dependsOn: [], action: 'next step', evidence: [] }]), { previous, required: true });
  assert.equal(omitted.error, null);
  assert.equal(omitted.outcome.workItems.find(i => i.id === 'open').status, 'ready');
  // Reopening a completed stage never undoes it: the stage stays done and the reopened work becomes s1-redo.
  const replay = inspectOutcome(round([{ id: 's1', title: 'stage 1', status: 'ready', dependsOn: [], action: 'redo', evidence: [] },
    { id: 'open', title: 'open stage', status: 'ready', dependsOn: ['s3'], action: 'do it', evidence: [] }]), { previous, required: true });
  assert.equal(replay.error, null);
  assert.match(replay.framingRecovery, /done-replay-split/);
  assert.equal(replay.outcome.workItems.find(i => i.id === 's1').status, 'done');
  assert.equal(replay.outcome.workItems.find(i => i.id === 's1-redo').status, 'ready');
  // a later round reopening s1 again updates the same correction stage instead of adding another
  const again = inspectOutcome(round([{ id: 's1', title: 'stage 1', status: 'ready', dependsOn: [], action: 'redo more', evidence: ['x'] },
    { id: 'open', title: 'open stage', status: 'ready', dependsOn: ['s3'], action: 'do it', evidence: [] }]), { previous: replay.outcome.workItems, required: true });
  assert.equal(again.error, null);
  assert.deepEqual(again.outcome.workItems.filter(i => i.id === 's1' || i.id.startsWith('s1-')).map(i => `${i.id}:${i.status}`), ['s1:done', 's1-redo:ready']);
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

test('a continuation round starting moves the issue state without posting a comment', async () => {
  const at = later();
  const { runtime } = await fixture({ comments: () => [{ id: 'c1', body: 'more', createdAt: at, updatedAt: at, user: { id: 'peer' } }] });
  await runtime.reviewComments();
  await runtime.dispatcher.update(s => { const t = s.tasks[1]; t.status = 'running'; t.executionNotice = true; t.report = 'pending'; t.events.push({ action: 'running', at: new Date().toISOString() }); });
  await runtime.report();
  const item = (await runtime.store.load()).outbox.find(i => i.taskStatus === 'running');
  assert.equal(item.body, '');
});

test('state-only reports never create a Linear comment', async () => {
  const calls = [];
  const client = new LinearClient('t', async (url, request) => {
    const { query } = JSON.parse(request.body); calls.push(query);
    const data = query.includes('organization') ? { organization: { id: 'w' } }
      : query.includes('issueUpdate') ? { issueUpdate: { success: true } }
      : query.includes('commentCreate') ? { commentCreate: { success: true } }
      : { issue: { state: { type: 'started' }, comments: { nodes: [], pageInfo: { hasNextPage: false } } } };
    return { status: 200, ok: true, headers: { get: () => null }, json: async () => ({ data }) };
  });
  await client.report({ id: 'r', issueId: 'i', body: '', stateId: 's' }, { workspaceId: 'w' });
  assert.ok(!calls.some(q => q.includes('commentCreate')));
  assert.ok(calls.some(q => q.includes('issueUpdate')));
  calls.length = 0;
  await client.report({ id: 'r2', issueId: 'i', body: 'result', stateId: 's' }, { workspaceId: 'w' });
  assert.ok(calls.some(q => q.includes('commentCreate')));
});

test('at the wake-up limit a comment starts an audit round in a fresh session with a new count', async () => {
  let n = 0;
  const { runtime } = await fixture({ followup: { maxWakeups: 1, maxAudits: 1 },
    comments: () => { const at = later(); return [{ id: `c${n++}`, body: `request ${n}`, createdAt: at, updatedAt: at, user: { id: 'peer' } }]; } });
  await runtime.reviewComments();                       // wake 1, original session
  await runtime.dispatcher.tick(); await runtime.assess();
  runtime.reviewCheckedAt.clear();
  await runtime.reviewComments();                       // limit reached: audit round
  let state = await runtime.snapshot();
  const audit = state.tasks[2];
  assert.equal(audit.session, undefined);
  assert.equal(audit.reviewWakeups, 0);
  assert.equal(audit.reviewAudits, 1);
  assert.match(audit.prompt, /AUDIT ROUND/);
  assert.equal(audit.events.at(-1).action, 'review-audit');
  // Audit used up and its own count used up: the next comment is only announced.
  await runtime.dispatcher.tick(); await runtime.assess();
  await runtime.dispatcher.update(s => { s.tasks[2].reviewWakeups = 1; });
  runtime.reviewCheckedAt.clear();
  await runtime.reviewComments();
  state = await runtime.snapshot();
  assert.equal(state.tasks.length, 3);
  assert.equal(state.tasks[2].reviewLimitNotified, true);
});

test('automatic follow-ups trim the oldest instructions instead of failing on a long history', async () => {
  let n = 0;
  const { runtime } = await fixture({ comments: () => { const at = later(); return [{ id: `c${n++}`, body: 'x'.repeat(7900), createdAt: at, updatedAt: at, user: { id: 'peer' } }]; } });
  await runtime.dispatcher.update(s => { s.tasks[0].ownerInstructions = Array.from({ length: 14 }, (_, i) => `old ${i} ${'y'.repeat(7900)}`); });
  await runtime.reviewComments();
  const next = (await runtime.snapshot()).tasks[1];
  assert.ok(next, 'continuation created');
  assert.match(next.ownerInstructions[0], /trimmed/);
  assert.ok(next.ownerInstructions.join('\n').length <= 100000);
  assert.match(next.ownerInstructions.at(-1), /x{100}/);
});

test('owner comments from the receiver account continue only when trusted, settled and not self-written', async () => {
  const settledAt = new Date(Date.now() - 10000).toISOString(), during = new Date(Date.now() - 20000).toISOString(), at = later();
  const cases = [
    [{ trustReceiverComments: true }, [{ id: 'o1', body: 'owner 决定：两个都要', createdAt: at, updatedAt: at, user: { id: 'me' } }], 2],
    [{ trustReceiverComments: true }, [{ id: 'o2', body: 'ZRSTUDIO：第 74 轮结论', createdAt: at, updatedAt: at, user: { id: 'me' } }], 1],
    [{ trustReceiverComments: true }, [{ id: 'o3', body: '中途说明', createdAt: during, updatedAt: during, user: { id: 'me' } }], 1],
    [{ trustReceiverComments: true }, [{ id: 'o5', body: 'owner 追加要求（轮次中发）', createdAt: during, updatedAt: during, user: { id: 'me' } }], 2],
    [{ trustReceiverComments: true, ownerCommentPrefix: 'owner|ULTRATOUF' }, [{ id: 'o6', body: 'ULTRATOUF：请改用新视图', createdAt: during, updatedAt: during, user: { id: 'me' } }], 2],
    [{ trustReceiverComments: true }, [{ id: 'o7', body: 'ULTRATOUF：请改用新视图', createdAt: during, updatedAt: during, user: { id: 'me' } }], 1],
    [{}, [{ id: 'o4', body: 'owner 决定', createdAt: at, updatedAt: at, user: { id: 'me' } }], 1]];
  for (const [followup, list, expected] of cases) {
    const { runtime } = await fixture({ followup, comments: () => list });
    await runtime.dispatcher.update(s => { const t = s.tasks[0]; t.createdAt = new Date(Date.now() - 60000).toISOString(); t.status = 'decision'; t.events.push({ action: 'decision', at: settledAt }); });
    await runtime.reviewComments();
    assert.equal((await runtime.snapshot()).tasks.length, expected, JSON.stringify(list[0].body));
  }
});

test('owner comments reach an automatic chain that never settles: queued now, running next round, settled via the normal path', async () => {
  const at = later();
  const list = [{ id: 'k1', body: 'owner：先重算主口径', createdAt: at, updatedAt: at, user: { id: 'me' } },
    { id: 'k2', body: '没有前缀的中途说明', createdAt: at, updatedAt: at, user: { id: 'me' } },
    { id: 'k3', body: 'ZRSTUDIO：本机回写', createdAt: at, updatedAt: at, user: { id: 'me' } }];
  const ledger = [{ id: 'a', title: 'a', status: 'ready', dependsOn: [], action: 'do a', evidence: [] }];
  const cont = ev => `<dispatch-result>${JSON.stringify({ status: 'continue', evidence: ['ok'], remaining: ['a'], next: 'do a', progress: `p ${ev}`,
    blockers: [], workItems: [{ id: 'a', title: 'a', status: 'ready', dependsOn: [], action: 'do a', evidence: [ev] }] })}</dispatch-result>`;
  const follow = { trustReceiverComments: true, maxAutoRounds: 50 };

  // 1. running round: the comment waits in pendingComments and is added to the next automatic round's prompt
  let { runtime } = await fixture({ followup: follow, comments: () => list });
  await runtime.dispatcher.update(s => { const t = s.tasks[0]; t.status = 'running'; t.createdAt = new Date(Date.now() - 60000).toISOString();
    t.workItems = ledger; t.workflowVersion = 2; t.attempts = [{ id: 'r', executor: 'codex', status: 'running', accepted: true, sessionId: 'original-session' }]; });
  await runtime.reviewComments();
  let t = (await runtime.snapshot()).tasks[0];
  assert.deepEqual(t.pendingComments.map(c => c.id), ['k1']);
  assert.equal(t.events.at(-1).action, 'comment-queued');
  await runtime.dispatcher.update(s => { const x = s.tasks[0]; x.status = 'review'; x.assessed = false; x.summary = cont('e1'); x.attempts[0].status = 'review'; });
  await runtime.assess();
  t = (await runtime.snapshot()).tasks[0];
  assert.equal(t.status, 'queued');
  assert.match(t.prompt, /OWNER COMMENTS/); assert.match(t.prompt, /先重算主口径/);
  assert.doesNotMatch(t.prompt, /没有前缀|本机回写/);
  assert.equal(t.pendingComments, undefined);
  runtime.reviewCheckedAt.clear(); await runtime.reviewComments();          // never delivered twice
  assert.equal((await runtime.snapshot()).tasks[0].events.filter(e => e.action.startsWith('comment-')).length, 2);

  // 2. queued round that has not started: the comment goes straight into its prompt
  ({ runtime } = await fixture({ followup: follow, comments: () => list }));
  await runtime.dispatcher.update(s => { const x = s.tasks[0]; x.status = 'queued'; x.attempts = []; x.prompt = 'base'; x.createdAt = new Date(Date.now() - 60000).toISOString(); });
  await runtime.reviewComments();
  t = (await runtime.snapshot()).tasks[0];
  assert.match(t.prompt, /^base[\s\S]*先重算主口径/); assert.equal(t.events.at(-1).action, 'comment-delivered');

  // 2b. a queued format-repair round never takes the comment; the next working round (here a fresh session) does
  ({ runtime } = await fixture({ followup: { ...follow, freshRescue: true }, comments: () => list }));
  await runtime.dispatcher.update(s => { const x = s.tasks[0]; x.status = 'queued'; x.attempts = []; x.prompt = 'repair only'; x.formatRepair = true;
    x.workItems = ledger; x.workflowVersion = 2; x.createdAt = new Date(Date.now() - 60000).toISOString(); x.events.push({ action: 'repair-result', at: new Date().toISOString() }); });
  await runtime.reviewComments();
  t = (await runtime.snapshot()).tasks[0];
  assert.equal(t.prompt, 'repair only'); assert.deepEqual(t.pendingComments.map(c => c.id), ['k1']);
  await runtime.dispatcher.update(s => { const x = s.tasks[0]; x.status = 'review'; x.assessed = false; x.summary = 'still not a result';
    x.attempts = [{ id: 'r2', executor: 'codex', status: 'review', accepted: true, sessionId: 'original-session' }]; });
  await runtime.assess();
  t = (await runtime.snapshot()).tasks[0];
  assert.match(t.prompt, /FRESH SESSION/); assert.match(t.prompt, /先重算主口径/); assert.equal(t.pendingComments, undefined);

  // 3. the round settles instead: the comment stays queued and the settled-round path continues the task with it,
  //    even when the issue is not reported dirty again (no new comment)
  ({ runtime } = await fixture({ followup: follow, comments: () => list }));
  await runtime.dispatcher.update(s => { const t = s.tasks[0]; t.status = 'running'; t.createdAt = new Date(Date.now() - 60000).toISOString();
    t.attempts = [{ id: 'r', executor: 'codex', status: 'running', accepted: true, sessionId: 'original-session' }]; });
  await runtime.reviewComments();
  await runtime.dispatcher.update(s => { const x = s.tasks[0]; x.status = 'review'; x.assessed = false; x.summary = done; x.attempts[0].status = 'review'; });
  await runtime.assess();
  t = (await runtime.snapshot()).tasks[0];
  assert.equal(t.status, 'review'); assert.deepEqual(t.pendingComments.map(c => c.id), ['k1']);
  runtime.reviewCheckedAt.clear(); runtime.commentDue = () => false; await runtime.reviewComments();
  const s = await runtime.snapshot();
  assert.equal(s.tasks.length, 2); assert.match(s.tasks[1].prompt, /OWNER COMMENTS[\s\S]*先重算主口径/);
  assert.equal(s.tasks[0].pendingComments, undefined);
  assert.equal(s.tasks[1].events.filter(e => e.action === 'comment-delivered').length, 1);
});

test('a new data version wakes a round waiting for data once; others are left alone', async () => {
  const { mkdtemp, writeFile } = await import('node:fs/promises');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'qm-ver-')), file = path.join(dir, 'current.txt');
  await writeFile(file, 'v1');
  const blockedOn = reason => s => { const t = s.tasks[0]; t.status = 'blocked';
    t.workItems = [{ id: 'need', title: 'next stage', status: 'blocked', dependsOn: [], action: '', evidence: [], blocker: { kind: 'external', owner: 'touf', reason, resumeWhen: 'touf 告知' } }];
    t.outcome = { blockers: [{ owner: 'touf', reason, resumeWhen: 'touf 告知' }] }; };
  const { runtime } = await fixture({ followup: { dataVersionFile: file } });
  await runtime.dispatcher.update(blockedOn('6 类数据未到位（分钟线、逐笔委托）'));
  await runtime.dataWakes();                                  // first sight: baseline only
  assert.equal((await runtime.snapshot()).tasks.length, 1);
  assert.equal((await runtime.store.load()).tasks[0].dataVersion, 'v1');
  await writeFile(file, 'v2');
  await runtime.dataWakes();
  let state = await runtime.snapshot();
  assert.equal(state.tasks.length, 2);
  assert.match(state.tasks[1].prompt, /DATA UPDATE/);
  assert.equal(state.tasks[1].dataVersion, 'v2');
  assert.equal(state.tasks[1].events.at(-1).action, 'data-wake');
  await runtime.dataWakes();                                  // same version: no second wake
  assert.equal((await runtime.snapshot()).tasks.length, 2);

  for (const setup of [blockedOn('等 owner 决定交付模式'), s => { s.tasks[0].status = 'review'; }]) {
    await writeFile(file, 'v1');
    const r = (await fixture({ followup: { dataVersionFile: file } })).runtime;
    await r.dispatcher.update(setup);
    await r.dataWakes(); await writeFile(file, 'v2'); await r.dataWakes();
    assert.equal((await r.snapshot()).tasks.length, 1);
  }
});

test('an unscoped reply wait on a permission decision is dropped, not a rejected round', () => {
  const r = inspectOutcome(`<dispatch-result>${JSON.stringify({ status: 'decision', evidence: ['ok'], remaining: ['owner picks A-D'], next: '', progress: 'x',
    blockers: [{ owner: 'owner', reason: 'pick', resumeWhen: 'reply' }],
    wait: { kind: 'linear', condition: 'owner replies A/B/C/D', expectedAuthorIds: ['peer'] },
    workItems: [{ id: 'a', title: 'done', status: 'done', dependsOn: [], action: '', evidence: ['e'] },
      { id: 'tag2', title: 'second tag', status: 'decision', dependsOn: ['a'], action: '', evidence: [],
        blocker: { kind: 'permission', owner: 'owner', reason: 'pick', resumeWhen: 'reply' } }] })}</dispatch-result>`, { required: true });
  assert.equal(r.error, null);
  assert.equal(r.outcome.wait, undefined);
  assert.match(r.framingRecovery, /unscoped-wait-dropped/);
});

test('restored ready stages do not force continue; reported ones still do', () => {
  const previous = [{ id: 'a', title: 'a', status: 'done', dependsOn: [], action: '', evidence: ['e'] },
    { id: 'old', title: 'old check', status: 'ready', dependsOn: [], action: 'check tonight', evidence: [] }];
  const result = items => `<dispatch-result>${JSON.stringify({ status: 'blocked', evidence: ['ok'], remaining: ['wait'], next: '', progress: 'x',
    blockers: [{ owner: 'touf', reason: 'data', resumeWhen: 'data arrives' }], workItems: items })}</dispatch-result>`;
  const blockedItem = { id: 'b', title: 'b', status: 'blocked', dependsOn: [], action: '', evidence: [], blocker: { kind: 'external', owner: 'touf', reason: 'data', resumeWhen: 'data arrives' } };
  const r = inspectOutcome(result([blockedItem]), { previous, required: true });
  assert.equal(r.error, null);
  assert.equal(r.outcome.workItems.find(i => i.id === 'old').status, 'ready');
  const reported = inspectOutcome(result([blockedItem, { ...previous[1] }]), { previous, required: true });
  assert.match(reported.error, /ready/);
});

test('an output-limit failure is retried once in the same session', async () => {
  const { runtime } = await fixture({ comments: () => [] });
  await runtime.dispatcher.update(s => { const t = s.tasks[0]; t.status = 'failed'; t.attempts.at(-1).reason = 'max-tokens'; t.attempts.at(-1).status = 'failed'; });
  await runtime.retryOutputLimit();
  let t = (await runtime.store.load()).tasks[0];
  assert.equal(t.status, 'queued'); assert.equal(t.outputLimitRetried, true); assert.match(t.prompt, /output limit/);
  await runtime.dispatcher.update(s => { const x = s.tasks[0]; x.status = 'failed'; x.attempts = [{ ...x.previousAttempts.at(-1), reason: 'max-tokens', status: 'failed' }]; });
  await runtime.retryOutputLimit();
  t = (await runtime.store.load()).tasks[0];
  assert.equal(t.status, 'failed');                      // only once
});

test('checks are throttled and stop at the wake-up limit', async () => {
  let n = 0;
  const { runtime, calls } = await fixture({ followup: { maxWakeups: 1, maxAudits: 0 },
    comments: () => { const at = later(); return [{ id: `c${n++}`, body: 'more', createdAt: at, updatedAt: at, user: { id: 'peer' } }]; } });
  await runtime.reviewComments();
  await runtime.dispatcher.tick(); await runtime.assess();
  runtime.reviewCheckedAt.clear();
  await runtime.reviewComments();
  let state = await runtime.snapshot();
  // At the limit the new comment is announced once, never executed.
  assert.equal(state.tasks.length, 2);
  assert.equal(calls.activity, 2);
  assert.equal(state.tasks[1].reviewLimitNotified, true);
  assert.equal(state.tasks[1].report, 'pending');
  assert.ok(state.errors.some(e => /已达上限/.test(e)));
  runtime.reviewCheckedAt.clear();
  await runtime.reviewComments();
  state = await runtime.snapshot();
  assert.equal(calls.activity, 2);
  assert.equal(state.tasks.length, 2);
});

// 2026-11-16: reading every waiting issue every two minutes (~35 issues x 3+ requests) passed Linear's
// 2,500 requests/hour. One project-wide query per pass now picks the issues that need a full read.
async function sweepFixture({ commented, comments = () => [] }) {
  const store = new MemoryStore(), state = initialState();
  state.paused = false;
  state.settings.projects = [{ id: 'p', label: 'Example', cwd: process.cwd(),
    linear: { enabled: true, tokenEnv: 'TEST_TOKEN', workspaceId: 'w', projectId: 'proj', assigneeId: 'me', round: '1', reviewStateId: 'review' },
    followup: { enabled: true, commentAuthorIds: ['peer', 'me'], maxWakeups: 8, reviewComments: true } }];
  await store.save(state);
  const calls = { activity: 0, sweep: 0, since: [] };
  const runtime = await new Runtime({ store, commentSweepMs: 0, directory: os.tmpdir(), env: { TEST_TOKEN: 'synthetic' }, linearFactory: () => ({
    eligible: async () => ({}),
    commentedIssues: async (mapping, since) => { calls.sweep++; calls.since.push(since); assert.equal(mapping.projectId, 'proj'); return commented(); },
    activity: async () => { calls.activity++; return { comments: comments() }; }
  }) }).init();
  runtime.adapters.codex = { start: async () => ({ status: 'review', summary: done, sessionId: 's' }) };
  await runtime.submit({ projectId: 'p', prompt: 'Work', issue: { id: 'issue', identifier: 'EX-1' }, source: 'w/issue' });
  await runtime.dispatcher.tick(); await runtime.assess();
  return { runtime, calls };
}

test('review comment checks read only issues the project-wide sweep reports', async () => {
  let flagged = [];
  const { runtime, calls } = await sweepFixture({ commented: () => new Set(flagged) });
  await runtime.reviewComments();                     // first pass after start: one full read of every issue
  assert.equal(calls.sweep, 0); assert.equal(calls.activity, 1);
  runtime.reviewCheckedAt.clear();
  await runtime.reviewComments();                     // nothing new: one cheap query, no per-issue read
  assert.equal(calls.sweep, 1); assert.equal(calls.activity, 1);
  flagged = ['other-issue'];
  runtime.reviewCheckedAt.clear();
  await runtime.reviewComments();                     // a comment elsewhere in the project does not read this issue
  assert.equal(calls.activity, 1);
  flagged = ['issue'];
  runtime.reviewCheckedAt.set((await runtime.snapshot()).tasks[0].id, Date.now() + 60000);
  await runtime.reviewComments();                     // flagged but not due yet: stays dirty
  assert.equal(calls.activity, 1);
  flagged = [];
  runtime.reviewCheckedAt.clear();
  await runtime.reviewComments();                     // still read once it is due, though the sweep moved on
  assert.equal(calls.activity, 2);
  runtime.reviewCheckedAt.clear();
  await runtime.reviewComments();                     // read clears the flag
  assert.equal(calls.activity, 2);
  assert.ok(calls.since.every(s => !Number.isNaN(Date.parse(s))));
});

test('a rate-limited sweep reads no issue and pauses until Linear allows again', async () => {
  let limited = false;
  const { runtime, calls } = await sweepFixture({ commented: () => {
    if (limited) { const e = new Error('limited'); e.code = 'RATE_LIMITED'; e.retryAfterMs = 600000; throw e; }
    return new Set(['issue']);
  } });
  await runtime.reviewComments();
  assert.equal(calls.activity, 1);
  limited = true; runtime.reviewCheckedAt.clear();
  await runtime.reviewComments();
  assert.equal(calls.activity, 1);
  assert.ok(runtime.commentPauseUntil > Date.now() + 500000);
  limited = false; runtime.reviewCheckedAt.clear();
  await runtime.reviewComments();                     // still paused: not even the sweep runs
  assert.equal(calls.sweep, 1); assert.equal(calls.activity, 1);
  runtime.commentPauseUntil = 0;
  await runtime.reviewComments();                     // the cursor did not move past the limited pass
  assert.equal(calls.activity, 2);
  assert.equal(calls.since[1], calls.since[0]);
});

test('LinearClient.commentedIssues asks once for the whole project', async () => {
  const bodies = [];
  const client = new LinearClient('t', async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return { ok: true, status: 200, headers: { get: () => null },
      json: async () => ({ data: { comments: { nodes: [{ id: 'c1', issue: { id: 'i1' } }, { id: 'c2', issue: { id: 'i1' } }, { id: 'c3', issue: { id: 'i2' } }],
        pageInfo: { hasNextPage: false, endCursor: null } } } }) };
  });
  const ids = await client.commentedIssues({ projectId: 'proj' }, '2026-11-16T00:00:00.000Z');
  assert.deepEqual([...ids].sort(), ['i1', 'i2']);
  assert.equal(bodies.length, 1);
  assert.deepEqual(bodies[0].variables.filter, { issue: { project: { id: { eq: 'proj' } } }, updatedAt: { gte: '2026-11-16T00:00:00.000Z' } });
});

// Session context rotation (followup.freshContextTokens, default 200000).
const continueResult = `<dispatch-result>${JSON.stringify({ status: 'continue', evidence: ['ok'], remaining: ['a'], next: 'do a', progress: 'new p',
  blockers: [], workItems: [{ id: 'a', title: 'a', status: 'ready', dependsOn: [], action: 'do a', evidence: ['fresh evidence'] }] })}</dispatch-result>`;
async function continuingRound(followup, contextTokens) {
  const { runtime } = await fixture({ followup });
  const reads = [];
  runtime.adapters.codex.contextTokens = async sessionId => { reads.push(sessionId); return contextTokens(); };
  await runtime.dispatcher.update(s => { const t = s.tasks[0]; t.workItems = [{ id: 'a', title: 'a', status: 'ready', dependsOn: [], action: 'do a', evidence: [] }];
    t.workflowVersion = 2; t.status = 'review'; t.assessed = false; t.summary = continueResult; });
  await runtime.assess();
  return { task: (await runtime.snapshot()).tasks[0], reads };
}

test('every round prompt asks for a HANDOFF.md update and a trials.jsonl check', async () => {
  const { starts } = await fixture();
  assert.match(starts[0].task.prompt, /update the task's HANDOFF\.md/);
  assert.match(starts[0].task.prompt, /otherwise HANDOFF\.md in this round's working directory/);
  assert.match(starts[0].task.prompt, /check trials\.jsonl/);
  const { task } = await continuingRound({}, async () => 1000);
  assert.match(task.prompt, /update the task's HANDOFF\.md/);
});

test('an automatic round whose session context exceeds the limit continues in a fresh session', async () => {
  const { task, reads } = await continuingRound({ freshRescue: true }, async () => 250000);
  assert.deepEqual(reads, ['original-session']);
  assert.equal(task.status, 'queued');
  assert.equal(task.session, undefined);
  assert.equal(task.sessionRounds, 0);
  assert.equal(task.events.at(-1).action, 'fresh-session');
  assert.match(task.events.at(-1).reason, /session context reached 250000 tokens/);
  assert.match(task.prompt, /FRESH SESSION: .*session context reached 250000 tokens/);
  assert.match(task.prompt, /first read the task's HANDOFF\.md.*trials\.jsonl/);
  // routine rotation does not use up the once-per-episode rescue
  assert.notEqual(task.freshRescued, true);
});

test('an automatic round keeps its session under the limit, on a failed read, or with rotation disabled', async () => {
  for (const [followup, read] of [[{}, async () => 200000], [{ freshContextTokens: 300000 }, async () => 250000],
    [{}, async () => { throw new Error('history unavailable'); }], [{}, async () => null], [{}, async () => 'n/a']]) {
    const { task } = await continuingRound(followup, read);
    assert.equal(task.status, 'queued');
    assert.equal(task.session?.id, 'original-session');
    assert.equal(task.events.at(-1).action, 'auto-continue');
  }
  const { task, reads } = await continuingRound({ freshContextTokens: 0 }, async () => 900000);
  assert.equal(task.session?.id, 'original-session');
  assert.deepEqual(reads, []);
});

test('a collaborator comment on a session with a large context continues in a fresh session', async () => {
  const at = later();
  const list = [{ id: 'c1', body: 'please dig further', createdAt: at, updatedAt: at, user: { id: 'peer' } }];
  for (const [tokens, fresh] of [[250000, true], [150000, false], [undefined, false]]) {
    const { runtime } = await fixture({ comments: () => list });
    runtime.adapters.codex.contextTokens = async () => { if (tokens === undefined) throw new Error('unreadable'); return tokens; };
    await runtime.reviewComments();
    const next = (await runtime.snapshot()).tasks[1];
    assert.match(next.prompt, /please dig further/);
    if (fresh) {
      assert.equal(next.session, undefined);
      assert.match(next.prompt, /FRESH SESSION: .*session context reached 250000 tokens/);
      assert.equal(next.events.at(-1).freshSession, 'the session context reached 250000 tokens');
      assert.equal(next.reviewWakeups, 1);           // an ordinary comment round, not an audit
    } else {
      assert.equal(next.session.id, 'original-session');
      assert.doesNotMatch(next.prompt, /FRESH SESSION/);
    }
  }
});

test('a context rotation from a comment keeps the full owner instruction history', async () => {
  const at = later();
  const { runtime } = await fixture({ comments: () => [{ id: 'c1', body: 'latest request', createdAt: at, updatedAt: at, user: { id: 'peer' } }] });
  await runtime.dispatcher.update(s => { s.tasks[0].ownerInstructions = Array.from({ length: 15 }, (_, i) => `instruction ${i}`); });
  runtime.adapters.codex.contextTokens = async () => 250000;
  await runtime.reviewComments();
  const next = (await runtime.snapshot()).tasks[1];
  assert.equal(next.session, undefined);
  assert.equal(next.ownerInstructions.length, 16);
  assert.match(next.prompt, /instruction 0/);
});

test('freshContextTokens is an optional non-negative integer', () => {
  const settings = initialState().settings;
  settings.projects = [{ id: 'p', label: 'P', cwd: process.cwd(), followup: { enabled: true, commentAuthorIds: [], freshContextTokens: 0 } }];
  assert.equal(settingsSchema.parse(settings).projects[0].followup.freshContextTokens, 0);
  settings.projects[0].followup.freshContextTokens = -1;
  assert.throws(() => settingsSchema.parse(settings));
});

test('retrying a stopped round whose session context exceeds the limit starts a fresh session with a handover', async () => {
  const stopped = s => { const t = s.tasks[0]; t.status = 'stopped'; t.prompt = 'ROUND PROMPT with ledger and previous summary'; };
  for (const [followup, read, fresh] of [[{}, async () => 250000, true], [{}, async () => 150000, false],
    [{}, async () => { throw new Error('unreadable'); }, false], [{ freshContextTokens: 0 }, async () => 900000, false]]) {
    const { runtime } = await fixture({ followup });
    const reads = [];
    runtime.adapters.codex.contextTokens = async id => { reads.push(id); return read(); };
    await runtime.dispatcher.update(stopped);
    await runtime.command({ action: 'retry', id: (await runtime.snapshot()).tasks[0].id });
    const t = (await runtime.snapshot()).tasks[0];
    assert.equal(t.status, 'queued');
    assert.deepEqual(t.executors, ['codex']);
    assert.match(t.prompt, /ROUND PROMPT with ledger and previous summary$/);
    if (fresh) {
      assert.equal(t.session, undefined);
      assert.match(t.prompt, /^FRESH SESSION: .*session context reached 250000 tokens/);
      assert.deepEqual(t.events.slice(-2).map(e => e.action), ['fresh-session', 'retry']);
      assert.notEqual(t.freshRescued, true);
    } else {
      assert.equal(t.session.id, 'original-session');
      assert.doesNotMatch(t.prompt, /FRESH SESSION/);
      assert.deepEqual(reads, followup.freshContextTokens === 0 ? [] : ['original-session']);
    }
  }
});

test('a retry ignores a context reading taken for a different session', async () => {
  const { runtime } = await fixture();
  await runtime.dispatcher.update(s => { s.tasks[0].status = 'stopped'; });
  const id = (await runtime.snapshot()).tasks[0].id;
  await runtime.dispatcher.action(id, 'retry', { freshSession: { sessionId: 'other-session', reason: 'x', handover: 'FRESH SESSION: x' } });
  const t = (await runtime.snapshot()).tasks[0];
  assert.equal(t.session.id, 'original-session');
  assert.doesNotMatch(t.prompt, /FRESH SESSION/);
});

test('a data wake on a session with a large context continues in a fresh session', async () => {
  const { mkdtemp, writeFile } = await import('node:fs/promises');
  for (const [tokens, fresh] of [[250000, true], [150000, false]]) {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'qm-ver-')), file = path.join(dir, 'current.txt');
    await writeFile(file, 'v1');
    const { runtime } = await fixture({ followup: { dataVersionFile: file } });
    runtime.adapters.codex.contextTokens = async () => tokens;
    await runtime.dispatcher.update(s => { const t = s.tasks[0]; t.status = 'blocked';
      t.workItems = [{ id: 'need', title: 'next stage', status: 'blocked', dependsOn: [], action: '', evidence: [], blocker: { kind: 'external', owner: 'touf', reason: '数据未到位', resumeWhen: '数据到位' } }];
      t.outcome = { blockers: [{ owner: 'touf', reason: '数据未到位', resumeWhen: '数据到位' }] }; });
    await runtime.dataWakes(); await writeFile(file, 'v2'); await runtime.dataWakes();
    const next = (await runtime.snapshot()).tasks[1];
    assert.match(next.prompt, /DATA UPDATE/);
    if (fresh) {
      assert.equal(next.session, undefined);
      assert.match(next.prompt, /FRESH SESSION: .*session context reached 250000 tokens/);
      assert.equal(next.events.at(-1).freshSession, 'the session context reached 250000 tokens');
    } else {
      assert.equal(next.session.id, 'original-session');
      assert.doesNotMatch(next.prompt, /FRESH SESSION/);
    }
  }
});

test('the project-wide comment sweep asks Linear at most once per interval', async () => {
  const { Runtime } = await import('../src/runtime.js');
  const { MemoryStore } = await import('../src/dispatcher.js');
  const store = new MemoryStore();
  await store.save({ tasks: [], settings: { concurrency: 1, executors: [], projects: [{ id: 'p', cwd: os.tmpdir(), maxConcurrent: 1,
    linear: { enabled: true, tokenEnv: 'TEST_TOKEN', workspaceId: 'w', projectId: 'proj' }, followup: { enabled: true, reviewComments: true, commentAuthorIds: ['u'] } }] } });
  let sweeps = 0;
  const runtime = new Runtime({ store, directory: os.tmpdir(), env: { TEST_TOKEN: 'synthetic' }, commentSweepMs: 60000,
    linearFactory: () => ({ commentedIssues: async () => { sweeps++; return new Set(); } }) });
  const state = await runtime.store.read();
  for (let i = 0; i < 5; i++) await runtime.commentSweep(state);
  assert.ok(sweeps <= 1, `swept ${sweeps} times within one interval`);
});
