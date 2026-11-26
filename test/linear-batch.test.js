// Linear merged exit (src/linear-outbox.js): request COUNTS over a fake transport (real LinearClient, no network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { MemoryStore } from '../src/dispatcher.js';
import { FileStore } from '../src/store.js';
import { initialState } from '../src/config.js';
import { Runtime } from '../src/runtime.js';
import { LinearClient } from '../src/linear.js';

const mapping = { enabled: true, tokenEnv: 'TEST_TOKEN', workspaceId: 'w', projectId: 'lp', assigneeId: 'owner', readyStateId: 'ready',
  activeStateId: 'active', reviewStateId: 'review', since: '2000-01-01T00:00:00Z', round: '1' };

/** A synthetic Linear endpoint that records every request and answers aliased mutations alias by alias. */
function fakeLinear() {
  const f = { calls: [], comments: new Map(), issues: new Map(), states: new Map(), reject: () => false, down: false, applyThenFail: false };
  f.fetch = async (url, request) => {
    assert.equal(url, 'https://api.linear.app/graphql');
    const { query, variables: v } = JSON.parse(request.body);
    f.calls.push({ query, variables: v });
    const ok = body => ({ ok: true, status: 200, headers: new Headers(), json: async () => body });
    if (f.down) return { ok: false, status: 503, headers: new Headers(), json: async () => ({}) };
    if (query.trim().startsWith('mutation(')) {
      const data = {}, errors = [];
      for (const [, alias, kind] of query.matchAll(/(\w+): (commentCreate|issueCreate|issueUpdate)\(/g)) {
        const input = v[alias];
        if (f.reject(kind, input, alias)) { data[alias] = null; errors.push({ message: 'synthetic rejection', path: [alias] }); continue; }
        if (kind === 'commentCreate') { f.comments.set(input.id, (f.comments.get(input.id) || 0) + 1); data[alias] = { success: true, comment: { id: input.id } }; }
        else if (kind === 'issueCreate') { f.issues.set(input.id, input); data[alias] = { success: true, issue: { id: input.id, identifier: `LP-${f.issues.size + 100}` } }; }
        else { f.states.set(v[`${alias}_id`], input.stateId); data[alias] = { success: true, issue: { id: v[`${alias}_id`], identifier: 'LP-1', state: { type: 'started' } } }; }
      }
      if (f.applyThenFail) { f.applyThenFail = false; return { ok: false, status: 502, headers: new Headers(), json: async () => ({}) }; }
      return ok({ data, ...(errors.length ? { errors } : {}) });
    }
    const data = { organization: { id: 'w' } };
    if (v?.comments) data.comments = { nodes: [...f.comments.keys()].filter(id => v.comments.id.in.includes(id)).map(id => ({ id })) };
    if (v?.issues) data.issues = { nodes: v.issues.id.in.map(id => ({ id, identifier: id, state: { id: 's', type: f.closed?.has(id) ? 'completed' : 'started' } })) };
    if (v?.filter?.id?.in) data.issues = { nodes: v.filter.id.in.map(id => ({ id, identifier: id.toUpperCase(), project: { id: 'lp' }, assignee: { id: 'owner' }, delegate: null, state: { id: 'ready', type: 'unstarted' } })),
      pageInfo: { hasNextPage: false, endCursor: null } };
    return ok({ data });
  };
  f.mutations = () => f.calls.filter(c => c.query.trim().startsWith('mutation('));
  f.aliases = call => [...call.query.matchAll(/(\w+): (commentCreate|issueCreate|issueUpdate)\(/g)].length;
  return f;
}

async function fixture({ store = new MemoryStore(), linearBatch = {}, f = fakeLinear(), seed = true } = {}) {
  if (seed) {
    const state = initialState(); state.paused = false;
    state.settings.projects = [{ id: 'p', label: 'Example', cwd: process.cwd(), linear: mapping }];
    state.settings.linearBatch = { flushIntervalMs: 0, ...linearBatch };
    await store.save(state);
  }
  const runtime = await new Runtime({ store, directory: os.tmpdir(), env: { TEST_TOKEN: 'synthetic' }, linearFactory: token => new LinearClient(token, f.fetch) }).init();
  return { runtime, f, store };
}
const roundItem = (n, extra = {}) => ({ id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, taskId: `t${n}`, projectId: 'p', roundReport: true,
  issueId: `issue-${n}`, body: `round ${n}`, status: 'pending', tries: 0, ...extra });

test('30 report comments + 5 state updates + 4 director enqueues leave in at most 2 requests', async () => {
  const { runtime, f } = await fixture();
  await runtime.dispatcher.update(s => {
    for (let n = 0; n < 30; n++) s.outbox.push(roundItem(n));
    for (let n = 30; n < 35; n++) s.outbox.push(roundItem(n, { body: '', stateId: 'active' }));
  }, { durable: true });
  // The sync already saw those issues' states (watched read): no guard read is needed.
  for (let n = 30; n < 35; n++) runtime.linearCache.put({ id: `issue-${n}`, state: { id: 'review', type: 'started' } });
  const queued = [];
  for (let n = 0; n < 4; n++) queued.push(await runtime.command({ action: 'linear-enqueue', caller: 'director', idempotencyKey: `review-${n}`,
    op: n < 2 ? { kind: 'comment', issue: `LON-${n + 1}`, body: `review ${n}` } : { kind: 'issueCreate', input: { teamId: 'team', title: `new ${n}`, description: 'x' } } }));
  assert.ok(queued.every(q => q.status === 'queued'));
  assert.equal(f.calls.length, 0, 'enqueue itself never calls Linear');
  await runtime.report();
  assert.ok(f.calls.length <= 2, `requests: ${f.calls.length}`);
  assert.equal(f.mutations().reduce((n, c) => n + f.aliases(c), 0), 39);
  assert.ok(f.mutations().every(c => f.aliases(c) <= 25));
  const state = await runtime.store.load();
  assert.ok(state.outbox.every(i => i.status === 'sent'));
  const results = await runtime.command({ action: 'linear-result', ids: queued.map(q => q.id) });
  assert.deepEqual(results.map(r => r.status), ['sent', 'sent', 'sent', 'sent']);
  assert.match(results[2].result.issueIdentifier, /^LP-/);
  assert.ok(results[0].result.commentId);
  assert.equal(runtime.linearUsage.snapshot().byPurpose['dispatcher/write'], f.calls.length);
});

test('flush waits for the interval unless enough items are pending', async () => {
  const { runtime, f } = await fixture({ linearBatch: { flushIntervalMs: 3600000, flushPending: 3 } });
  await runtime.dispatcher.update(s => { s.outbox.push(roundItem(1)); }, { durable: true });
  await runtime.report(); assert.equal(f.calls.length, 1); // first flush after start
  await runtime.dispatcher.update(s => { s.outbox.push(roundItem(2)); }, { durable: true });
  await runtime.report(); assert.equal(f.calls.length, 1, 'within the window one item waits');
  await runtime.dispatcher.update(s => { s.outbox.push(roundItem(3), roundItem(4)); }, { durable: true });
  await runtime.report(); assert.equal(f.calls.length, 2, 'flushPending reached: all leave in one request');
  assert.equal(f.aliases(f.calls[1]), 3);
});

test('a partial alias failure retries only the failed item, alone', async () => {
  const { runtime, f } = await fixture();
  f.reject = (kind, input) => kind === 'commentCreate' && input.body === 'round 2';
  await runtime.dispatcher.update(s => { for (let n = 1; n <= 4; n++) s.outbox.push(roundItem(n)); }, { durable: true });
  await runtime.report();
  let state = await runtime.store.load();
  assert.deepEqual(state.outbox.map(i => i.status), ['sent', 'pending', 'sent', 'sent']);
  assert.equal(state.outbox[1].tries, 1); assert.match(state.outbox[1].lastError, /拒绝/);
  f.reject = () => false; f.calls = [];
  await runtime.dispatcher.update(s => { s.outbox[1].nextAt = 0; });
  await runtime.report();
  const mutation = f.mutations();
  assert.equal(mutation.length, 1); assert.equal(f.aliases(mutation[0]), 1);
  assert.equal(mutation[0].variables.c0.body, 'round 2');
  state = await runtime.store.load();
  assert.ok(state.outbox.every(i => i.status === 'sent'));
  assert.ok([...f.comments.values()].every(n => n === 1));
});

test('an unknown outcome is checked in one read before resending: no duplicate comment', async () => {
  const { runtime, f } = await fixture();
  f.applyThenFail = true; // Linear applied the writes, the response was lost
  await runtime.dispatcher.update(s => { for (let n = 1; n <= 3; n++) s.outbox.push(roundItem(n)); }, { durable: true });
  await runtime.report();
  assert.ok((await runtime.store.load()).outbox.every(i => i.status === 'pending' && i.tries === 1));
  f.calls = [];
  await runtime.dispatcher.update(s => { for (const i of s.outbox) i.nextAt = 0; });
  await runtime.report();
  assert.equal(f.calls.length, 1, 'one check read, nothing left to send');
  assert.ok((await runtime.store.load()).outbox.every(i => i.status === 'sent'));
  assert.ok([...f.comments.values()].every(n => n === 1));
});

test('a state move whose state is not cached costs one shared guard read; closed issues are never moved', async () => {
  const { runtime, f } = await fixture();
  f.closed = new Set(['issue-2']);
  await runtime.dispatcher.update(s => { for (let n = 1; n <= 3; n++) s.outbox.push(roundItem(n, { stateId: 'active' })); }, { durable: true });
  await runtime.report();
  assert.equal(f.calls.length, 2, 'one guard read + one mutation');
  assert.equal(f.states.get('issue-1'), 'active'); assert.equal(f.states.has('issue-2'), false); assert.equal(f.states.get('issue-3'), 'active');
  assert.ok((await runtime.store.load()).outbox.every(i => i.status === 'sent'));
});

test('enqueue is idempotent, whitelisted and survives a restart (durable Linear outbox)', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'linear-batch-'));
  try {
    let store = await new FileStore(directory).open();
    const first = await fixture({ store });
    const op = { kind: 'comment', issue: 'LON-9', body: 'hello' };
    const a = await first.runtime.command({ action: 'linear-enqueue', caller: 'push-queue', idempotencyKey: 'k1', op });
    const b = await first.runtime.command({ action: 'linear-enqueue', caller: 'push-queue', idempotencyKey: 'k1', op });
    assert.equal(a.status, 'queued'); assert.deepEqual(b, { id: a.id, status: 'duplicate' });
    await assert.rejects(first.runtime.command({ action: 'linear-enqueue', caller: 'ops', idempotencyKey: 'k2', op: { kind: 'issueUpdate', issue: 'LON-9', input: { title: 'x' } } }), /只允许/);
    await assert.rejects(first.runtime.command({ action: 'linear-enqueue', caller: 'someone', idempotencyKey: 'k3', op }), /caller/);
    assert.equal(first.f.calls.length, 0);
    await store.close();
    // Restart: a new store and runtime read the same files; the item is still there and is sent exactly once.
    store = await new FileStore(directory).open();
    const second = await fixture({ store, seed: false, f: first.f });
    assert.deepEqual((await second.runtime.command({ action: 'linear-result', ids: [a.id] })).map(r => r.status), ['queued']);
    const again = await second.runtime.command({ action: 'linear-enqueue', caller: 'push-queue', idempotencyKey: 'k1', op });
    assert.equal(again.status, 'duplicate');
    await second.runtime.report(); await second.runtime.report();
    assert.equal(first.f.comments.get(a.id), 1);
    assert.equal((await second.runtime.command({ action: 'linear-result', ids: [a.id] }))[0].status, 'sent');
    await store.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Linear failure never reruns coding: a down endpoint only backs the outbox off', async () => {
  const { runtime, f } = await fixture();
  f.down = true;
  await runtime.dispatcher.update(s => { s.outbox.push(roundItem(1)); }, { durable: true });
  await runtime.report();
  const item = (await runtime.store.load()).outbox[0];
  assert.equal(item.status, 'pending'); assert.equal(item.tries, 1); assert.ok(item.nextAt > Date.now());
  const results = await runtime.command({ action: 'linear-enqueue', caller: 'ops', idempotencyKey: 'x', op: { kind: 'comment', issue: 'LON-1', body: 'b' } });
  f.calls = []; await runtime.report();
  assert.equal(f.calls.length, 1, 'the backed-off item waits; only the new one is tried');
  assert.equal((await runtime.command({ action: 'linear-result', ids: [results.id] }))[0].status, 'retrying');
});

test('10 tasks starting in one cycle cause at most 1 eligibility read; a fresh sync cache causes none', async () => {
  const { runtime, f } = await fixture();
  await runtime.dispatcher.update(s => { s.settings.concurrency = 10; s.settings.startConcurrency = 10; s.settings.projects[0].maxConcurrent = 10;
    s.settings.executors = [{ id: 'codex', type: 'codex', label: 'Fake', command: 'codex', args: [], sandbox: 'read-only', enabled: true }]; });
  runtime.adapters.codex = { start: async () => ({ status: 'running', sessionId: 's' }), reconcile: async () => ({ status: 'running' }), health: async () => ({ available: true }) };
  for (let n = 0; n < 10; n++) await runtime.submit({ projectId: 'p', title: `LP-${n}`, prompt: 'x', source: `w/i${n}`, round: '1', issue: { id: `i${n}`, identifier: `LP-${n}` } });
  f.calls = [];
  await runtime.dispatcher.tick();
  const reads = f.calls.filter(c => c.query.includes('issues(filter'));
  assert.equal(reads.length, 1, `eligibility reads: ${reads.length}`);
  assert.equal((await runtime.store.load()).tasks.filter(t => t.status === 'running').length, 10);
  // Next queued batch: the sync's watched read already saw them, so admission reads nothing.
  for (let n = 10; n < 13; n++) {
    await runtime.submit({ projectId: 'p', title: `LP-${n}`, prompt: 'x', source: `w/i${n}`, round: '1', issue: { id: `i${n}`, identifier: `LP-${n}` } });
    runtime.linearCache.put({ id: `i${n}`, project: { id: 'lp' }, assignee: { id: 'owner' }, state: { id: 'ready', type: 'unstarted' } });
  }
  await runtime.dispatcher.update(s => { s.settings.concurrency = 13; s.settings.projects[0].maxConcurrent = 13; });
  f.calls = []; await runtime.dispatcher.tick();
  assert.equal(f.calls.length, 0);
  // A cached issue that was closed fails closed without any request.
  await runtime.submit({ projectId: 'p', title: 'LP-99', prompt: 'x', source: 'w/i99', round: '1', issue: { id: 'i99', identifier: 'LP-99' } });
  runtime.linearCache.put({ id: 'i99', project: { id: 'lp' }, assignee: { id: 'owner' }, state: { id: 'done', type: 'completed' } });
  await runtime.dispatcher.update(s => { s.settings.concurrency = 14; s.settings.projects[0].maxConcurrent = 14; });
  await runtime.dispatcher.tick();
  const closed = (await runtime.store.load()).tasks.find(t => t.issue?.id === 'i99');
  assert.equal(closed.status, 'queued'); assert.ok(closed.admissionError); assert.equal(f.calls.length, 0);
});

test('linear-view answers from the sync cache only and never hits the network', async () => {
  const { runtime, f } = await fixture();
  runtime.linearCache.put({ id: 'i1', identifier: 'LP-1', title: 'one', project: { id: 'lp' }, assignee: { id: 'owner' }, delegate: { id: 'bot' }, state: { id: 's', type: 'started' }, updatedAt: '2026-11-26T01:00:00.000Z' });
  runtime.linearCache.put({ id: 'i2', identifier: 'OT-1', title: 'other', project: { id: 'other' }, updatedAt: '2026-11-26T02:00:00.000Z' });
  runtime.linearCache.putComment({ id: 'c1', issueId: 'i1', authorId: 'owner', body: '紧急', createdAt: '2026-11-26T03:00:00.000Z' });
  runtime.linearCache.putComment({ id: 'c0', issueId: 'i1', authorId: 'owner', body: 'old', createdAt: '2026-11-25T03:00:00.000Z' });
  runtime.linearCache.synced();
  const view = await runtime.command({ action: 'linear-view', projectId: 'lp', since: '2026-11-26T00:00:00.000Z', include: ['issues', 'comments'] });
  assert.equal(f.calls.length, 0);
  assert.deepEqual(view.issues, [{ id: 'i1', identifier: 'LP-1', title: 'one', state: { id: 's', type: 'started' }, assigneeId: 'owner', delegateId: 'bot', updatedAt: '2026-11-26T01:00:00.000Z' }]);
  assert.deepEqual(view.comments.map(c => [c.id, c.issueIdentifier, c.authorIsBot]), [['c1', 'LP-1', false]]);
  assert.ok(view.cacheAt);
  await assert.rejects(runtime.command({ action: 'linear-view', since: 'yesterday' }), /ISO/);
  assert.equal(f.calls.length, 0);
});

test('linearUsage counts requests per caller and purpose and warns over the budget fraction', async () => {
  const { runtime, f } = await fixture({ linearBatch: { hourlyBudget: 10, warnFraction: 0.3 } });
  await runtime.dispatcher.update(s => { for (let n = 1; n <= 4; n++) s.outbox.push(roundItem(n, { nextAt: 0 })); }, { durable: true });
  for (let n = 0; n < 4; n++) { await runtime.dispatcher.update(s => { s.outbox.push(roundItem(10 + n)); }, { durable: true }); await runtime.report(); }
  const snap = await runtime.snapshot();
  assert.equal(snap.linearUsage.total, f.calls.length);
  assert.equal(snap.linearUsage.byCaller.dispatcher, f.calls.length);
  assert.ok(snap.linearUsage.over);
  assert.ok(snap.errors.some(e => /Linear 请求本小时/.test(e)));
});
