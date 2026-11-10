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
