// Batched activity reads (Runtime.readActivity / LinearClient.activities): request COUNTS over the synthetic Linear
// world of the acceptance harness (real Runtime cycles, real LinearClient, no network).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { world, result, forbidNetwork, restoreNetwork, sleep } from './acceptance/harness.js';
import { LinearClient, ACTIVITY_MAX_PAIRS, ACTIVITY_MAX_COMMENTS } from '../src/linear.js';

before(forbidNetwork);
after(restoreNetwork);
const ready = (w, id) => w.linear.issue(id, { identifier: id.toUpperCase(), assignee: { id: 'touf' } });
const WAITING = result('blocked', { wait: { kind: 'linear', expectedAuthorIds: ['peer'], condition: '等 peer 回执' } });
const isActivity = c => c.query.startsWith('query($issues:IssueFilter!, $comments:CommentFilter!');
const isPage = c => c.query.startsWith('query($comments:CommentFilter!, $after:String)');
const perIssue = c => /issue\(id:\$id\)/.test(c.query);

async function settled({ done = 10, waits = 3 } = {}) {
  const n = done + waits;
  const w = await world({ settings: s => { s.concurrency = n; s.projects[0].maxConcurrent = n; return s; } });
  const doneIds = Array.from({ length: done }, (_, i) => `ax-${i + 1}`), waitIds = Array.from({ length: waits }, (_, i) => `wx-${i + 1}`);
  for (const id of [...doneIds, ...waitIds]) ready(w, id);
  for (const id of waitIds) w.executor.script(id.toUpperCase(), WAITING);
  await w.cycle(5);
  for (const id of doneIds) assert.equal((await w.last(id.toUpperCase())).status, 'review', id);
  for (const id of waitIds) { const t = await w.last(id.toUpperCase()); assert.equal(t.wait?.status, 'watching', JSON.stringify([id, t.status, t.wait, t.events.slice(-4).map(e => e.action)])); }
  return { w, doneIds, waitIds };
}

test('10 dirty tasks with new comments + 3 waits in one cycle: at most 1 activity read (plus the sweep), no per-issue read', async () => {
  const { w, doneIds, waitIds } = await settled();
  try {
    await sleep(5);
    for (const id of [...doneIds, ...waitIds]) w.linear.comment(id, 'peer', `再看一下 ${id}`);
    const from = w.linear.calls.length;
    await w.cycle(1);
    const calls = w.linear.calls.slice(from);
    assert.equal(calls.filter(isActivity).length, 1, 'all comment reads of the cycle share one request');
    assert.equal(calls.filter(isPage).length, 0);
    assert.equal(calls.filter(perIssue).length, 0, 'no per-issue activity / eligibility read');
    // The comments did their work: every settled round continues once, every wait woke.
    for (const id of doneIds) {
      const rounds = await w.tasks(id.toUpperCase());
      assert.equal(rounds.length, 2, id); assert.match(rounds[1].prompt, new RegExp(`再看一下 ${id}`));
    }
    for (const id of waitIds) { const t = (await w.tasks(id.toUpperCase())); assert.equal(t[0].wakeups, 1, JSON.stringify(t.map(x => [x.status, x.wakeups, x.wait?.status, x.wait?.error, x.events.slice(-3).map(e => e.action)]))); }
    // The read fed the shared cache (linear-view sees the comments).
    const view = await w.runtime.command({ action: 'linear-view', include: ['comments'] });
    for (const id of doneIds) assert.ok(view.comments.some(c => c.body === `再看一下 ${id}`), id);
    assert.deepEqual(w.linear.unknown, []);
  } finally { await w.close(); }
});

test('waits monitored outside the sync and an arm-wait check go through the same batched reader', async () => {
  const { w, waitIds } = await settled({ done: 1, waits: 3 });
  try {
    await sleep(5);
    for (const id of waitIds) w.linear.comment(id, 'peer', '回执已到');
    let from = w.linear.calls.length;
    await w.runtime.monitor();   // no sync-supplied activities: the 3 waits are read together
    let calls = w.linear.calls.slice(from);
    assert.equal(calls.filter(isActivity).length, 1); assert.equal(calls.filter(perIssue).length, 0);
    for (const id of waitIds) assert.equal((await w.tasks(id.toUpperCase()))[0].status, 'queued', id);
    // arm-wait (owner action): one read through the same reader, coalesced with a wait read registered in the same tick.
    const blocked = await w.last('AX-1');
    await w.runtime.dispatcher.update(s => { const t = s.tasks.find(x => x.id === blocked.id); t.status = 'blocked'; });
    from = w.linear.calls.length;
    const state = await w.runtime.store.read(), project = state.settings.projects[0];
    const [armed] = await Promise.all([
      w.runtime.command({ action: 'arm-wait', id: blocked.id, wait: { kind: 'linear', expectedAuthorIds: ['peer'], condition: '等 peer' } }).catch(e => e),
      w.runtime.readActivity(project, state.settings, 'wx-1', 'wx-1', { purpose: 'wait', since: new Date().toISOString() })
    ]);
    calls = w.linear.calls.slice(from);
    assert.equal(calls.filter(isActivity).length, 1, 'arm-wait validation shares the pending read');
    assert.equal(calls.filter(perIssue).length, 0);
    assert.ok(!(armed instanceof Error), String(armed?.message));
    assert.equal((await w.last('AX-1')).wait?.kind, 'linear');
    assert.equal(w.runtime.linearUsage.snapshot().byPurpose['dispatcher/activity'], 1, 'one request, mixed purposes (arm-wait + wait)');
  } finally { await w.close(); }
});

test('an issue that is closed or reassigned fails only its own pair; a failed read fails every caller (fail closed)', async () => {
  const { w, waitIds } = await settled({ done: 0, waits: 3 });
  try {
    const state = await w.runtime.store.read(), project = state.settings.projects[0];
    w.linear.touch('wx-2', { state: { id: 'done', type: 'completed' } });
    const reads = waitIds.map(id => w.runtime.readActivity(project, state.settings, id, id, { purpose: 'wait' }).then(v => v, e => e));
    const [a, b, c] = await Promise.all(reads);
    assert.equal(a.id, 'wx-1'); assert.equal(c.id, 'wx-3');
    assert.match(b.message, /closed, reassigned/);
    const realFetch = w.linear.fetch, from = w.linear.calls.length;
    w.runtime.linearFactory = token => new LinearClient(token, async () => ({ status: 503, ok: false, headers: new Map(), json: async () => ({}) }));
    const failed = await Promise.all(waitIds.map(id => w.runtime.readActivity(project, state.settings, id, id, { purpose: 'wait' }).then(() => null, e => e)));
    assert.ok(failed.every(e => e instanceof Error && /HTTP 503/.test(e.message)));
    w.runtime.linearFactory = token => new LinearClient(token, realFetch);
    assert.equal(w.linear.calls.length, from);
  } finally { await w.close(); }
});

test('bounds: more than the comment limit fails closed (no partial result); more pairs than one request are chunked, not dropped', async () => {
  const mapping = { workspaceId: 'w', projectId: 'lp', assigneeId: 'touf' };
  const issue = id => ({ id, identifier: id, project: { id: 'lp' }, assignee: { id: 'touf' }, state: { type: 'started' }, parent: null });
  let calls = 0;
  const endless = new LinearClient('k', async (_, init) => {
    calls++;
    const { variables: v } = JSON.parse(init.body), after = Number(v.after || 0);
    const nodes = Array.from({ length: 250 }, (_, i) => ({ id: `c${after + i}`, body: '', createdAt: 'x', updatedAt: 'x', user: { id: 'peer' }, issue: { id: 'i1' } }));
    return { ok: true, status: 200, headers: new Map(), json: async () => ({ data: { organization: { id: 'w' }, issues: { nodes: [issue('i1')] },
      comments: { nodes, pageInfo: { hasNextPage: true, endCursor: String(after + 250) } } } }) };
  });
  await assert.rejects(endless.activities([{ issueId: 'i1', parentId: 'i1', mapping }]), e => e.code === 'LINEAR_READ_BOUNDS');
  assert.equal(calls, ACTIVITY_MAX_COMMENTS / 250, 'stops at the bound');
  await assert.rejects(endless.activities(Array.from({ length: ACTIVITY_MAX_PAIRS + 1 }, (_, i) => ({ issueId: `i${i}`, parentId: `i${i}`, mapping }))),
    e => e.code === 'LINEAR_READ_BOUNDS');
  // The runtime chunks a larger tick instead: 150 pairs -> 2 requests, every pair answered.
  const { w } = await settled({ done: 1, waits: 0 });
  try {
    const state = await w.runtime.store.read(), project = state.settings.projects[0];
    for (let i = 0; i < 150; i++) ready(w, `bx-${i}`);
    const from = w.linear.calls.length;
    const values = await Promise.all(Array.from({ length: 150 }, (_, i) => w.runtime.readActivity(project, state.settings, `bx-${i}`, `bx-${i}`, { purpose: 'comments' })));
    assert.equal(values.length, 150); assert.ok(values.every((v, i) => v.id === `bx-${i}`));
    assert.equal(w.linear.calls.slice(from).filter(isActivity).length, 2);
  } finally { await w.close(); }
});
