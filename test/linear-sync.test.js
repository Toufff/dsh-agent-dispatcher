import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { Runtime } from '../src/runtime.js';
import { LinearClient } from '../src/linear.js';
import { LinearSync } from '../src/linear-sync.js';
import { MemoryStore } from '../src/dispatcher.js';
import { initialState } from '../src/config.js';
import { domainSpec } from '../src/plugin.js';

async function fixture({ count = 1 } = {}) {
  const store = new MemoryStore(), state = initialState(); state.paused = false;
  const mapping = { enabled: true, tokenEnv: 'TEST_TOKEN', workspaceId: 'w', projectId: 'p', assigneeId: 'owner', readyStateId: 'ready', reviewStateId: 'review', since: '2000-01-01T00:00:00Z', round: '1' };
  state.settings.projects = [{ id: 'local', label: 'Synthetic', cwd: os.tmpdir(), linear: mapping, followup: { enabled: true, commentAuthorIds: ['peer'], maxWakeups: 8 } }];
  await store.save(state);
  const f = { store, now: Math.ceil(Date.now() / 1000) * 1000 + 10000, issues: [], comments: [], calls: [], starts: 0, fail: '', pageSize: 100 };
  const fetcher = async (_, request) => {
    const { query, variables: v } = JSON.parse(request.body); f.calls.push({ query, variables: v });
    const response = (data, status = 200) => ({ ok: status === 200, status, headers: new Headers({ date: new Date(f.now).toUTCString(), 'retry-after': '120' }), json: async () => ({ data }) });
    if (f.fail === 'rate') return response(null, 429);
    if (f.fail === 'offline') return response(null, 503);
    if (query.includes('organization')) return response({ organization: { id: 'w' } });
    if (v.id) return response({ issue: f.issues.find(i => i.id === v.id) });
    const kind = query.includes('CommentFilter') ? 'comments' : 'issues';
    if (f.fail === kind || f.fail === 'intake' && v.filter.or) return response(null, 503);
    let items;
    if (kind === 'comments') items = f.comments.filter(c => v.filter.issue.id.in.includes(c.issue.id) && c.updatedAt >= v.filter.updatedAt.gte && c.updatedAt <= v.filter.updatedAt.lte);
    else if (v.filter.id) items = f.issues.filter(i => v.filter.id.in.includes(i.id));
    else items = f.issues.filter(i => v.filter.or.some(m => i.project.id === m.project.id.eq && i.assignee.id === m.assignee.id.eq && i.state.id === m.state.id.eq && i.updatedAt >= m.updatedAt.gte && i.updatedAt <= m.updatedAt.lte));
    const start = Number(v.after || 0), nodes = items.slice(start, start + f.pageSize), end = start + nodes.length;
    return response({ [kind]: { nodes, pageInfo: { hasNextPage: end < items.length, endCursor: String(end) } } });
  };
  f.make = async () => {
    const r = await new Runtime({ store, directory: os.tmpdir(), env: { TEST_TOKEN: 'synthetic' }, linearFactory: token => new LinearClient(token, fetcher) }).init();
    r.sync = new LinearSync(r, { now: () => f.now });
    r.adapters.codex = { start: async ({ task, attempt }) => {
      f.starts++; const resumed = !!attempt.resume;
      if (resumed) assert.equal(attempt.sessionId, `session-${task.issue.id}`);
      const outcome = resumed ? { status: 'complete', evidence: ['isolated'], remaining: [], blockers: [], next: '', progress: 'complete' }
        : { status: 'blocked', evidence: ['isolated'], remaining: ['reply'], blockers: [{ owner: 'peer', reason: 'reply', resumeWhen: 'reply' }], next: '', progress: 'waiting', wait: { kind: 'linear', condition: 'verified receipt', issueId: task.issue.id } };
      return { status: 'review', sessionId: `session-${task.issue.id}`, summary: `<dispatch-result>${JSON.stringify(outcome)}</dispatch-result>` };
    } };
    return r;
  };
  f.addIssue = (id, status = 'started') => { const i = { id, identifier: `EX-${id}`, title: 'Synthetic', description: 'Isolated', url: 'https://linear.app/example', updatedAt: new Date(f.now - 1000).toISOString(), project: { id: 'p' }, assignee: { id: 'owner' }, state: { id: status, type: status === 'ready' ? 'unstarted' : 'started' } }; f.issues.push(i); return i; };
  f.reply = (id, issueId = 'a0', user = 'peer') => { const c = { id, issue: { id: issueId }, user: { id: user }, body: 'Verify this receipt', updatedAt: new Date(f.now - 1000).toISOString() }; f.comments.push(c); return c; };
  f.r = await f.make();
  for (let n = 0; n < count; n++) { const issue = f.addIssue(`a${n}`); await f.r.submit({ projectId: 'local', prompt: 'Synthetic', issue }); await f.r.dispatcher.tick(); await f.r.assess(); }
  f.calls = []; return f;
}

test('workspace sync batches waits, coalesces concurrent checks, and idles without page-driven network reads', async () => {
  const f = await fixture({ count: 3 });
  await f.r.dispatcher.update(s => { s.settings.projects.push({ ...structuredClone(s.settings.projects[0]), id: 'second' }); });
  await Promise.all([f.r.sync.run(), f.r.sync.run({ force: true }), f.r.sync.run()]);
  assert.equal(f.calls.length, 4); // organization, ready issues, all watched metadata, all comments
  const saved = Object.values((await f.store.load()).linearSync)[0];
  domainSpec.global.schema.parse(await f.store.load());
  assert.ok(saved.cursor); assert.equal(saved.intervalMs, 60000);
  await f.r.snapshot(); await f.r.snapshot(); await f.r.sync.run(); assert.equal(f.calls.length, 4);
  f.now += 61000; await f.r.sync.run();
  const delta = f.calls.findLast(c => c.variables.filter?.or);
  assert.ok(delta.variables.filter.or[0].updatedAt.gte > '2000-01-01T00:00:00Z');
  assert.equal(Object.values((await f.store.load()).linearSync)[0].intervalMs, 120000);
});

test('separate comment delta sees edits with unchanged issue timestamp and wakes original session once after restart', async () => {
  const f = await fixture(); f.reply('reply', 'a0', 'stranger'); await f.r.sync.run();
  f.now += 125000; f.comments[0].user.id = 'peer'; f.comments[0].updatedAt = new Date(f.now - 1000).toISOString();
  f.r = await f.make(); await f.r.sync.run();
  let t = (await f.store.load()).tasks[0]; assert.equal(t.status, 'queued'); assert.equal(t.wakeups, 1);
  await f.r.dispatcher.tick(); await f.r.assess();
  assert.equal(f.starts, 2); assert.equal((await f.store.load()).tasks[0].status, 'review');
  await f.r.sync.run({ force: true }); await f.r.dispatcher.tick(); assert.equal(f.starts, 2);
});

test('buffered reply survives an unavailable executor, cursor advance and restart', async () => {
  const f = await fixture(); await f.r.dispatcher.update(s => { s.settings.executors[0].enabled = false; });
  f.reply('receipt'); await f.r.sync.run(); assert.equal((await f.store.load()).tasks[0].status, 'blocked');
  domainSpec.global.schema.parse(await f.store.load());
  const publicState = await f.r.snapshot();
  assert.equal(publicState.linearSync, undefined);
  assert.equal(JSON.stringify(publicState.syncStatus).includes('Verify this receipt'), false);
  f.now += 125000; f.r = await f.make();
  await f.r.dispatcher.update(s => { s.settings.executors[0].enabled = true; });
  await f.r.sync.run(); assert.equal((await f.store.load()).tasks[0].status, 'queued');
  await f.r.dispatcher.tick(); assert.equal(f.starts, 2);
});

test('rate limits persist cooldown across restart and manual sync cannot bypass it', async () => {
  const f = await fixture(); await f.r.sync.run(); const cursor = Object.values((await f.store.load()).linearSync)[0].cursor;
  f.now += 125000; f.fail = 'rate'; await f.r.sync.run(); const calls = f.calls.length;
  const saved = Object.values((await f.store.load()).linearSync)[0]; assert.equal(saved.cursor, cursor); assert.equal(saved.retryAt, f.now + 120000);
  f.r = await f.make(); await f.r.sync.run({ force: true }); assert.equal(f.calls.length, calls);
  f.now += 120001; f.fail = ''; f.reply('new'); await f.r.sync.run();
  assert.equal((await f.store.load()).tasks[0].wakeups, 1); assert.equal(Object.values((await f.store.load()).linearSync)[0].failures, 0);
});

test('partial intake failure does not starve comments and partial comments failure does not lose intake', async () => {
  const f = await fixture(); f.fail = 'intake'; f.reply('receipt'); await f.r.sync.run();
  assert.equal((await f.store.load()).tasks[0].status, 'queued');
  assert.ok(!Object.values((await f.store.load()).linearSync)[0].cursor);
  const g = await fixture(); g.addIssue('new', 'ready'); g.fail = 'comments'; await g.r.sync.run();
  assert.equal((await g.store.load()).tasks.length, 2);
  assert.ok(!Object.values((await g.store.load()).linearSync)[0].cursor);
  g.now += 31000; g.fail = ''; await g.r.sync.run(); assert.equal((await g.store.load()).tasks.length, 2);
});

test('local intake failure still delivers replies, while failed inbox persistence never wakes work', async () => {
  const f = await fixture(); f.reply('receipt');
  f.r.intake = async () => { throw new Error('Local directory unavailable'); };
  await f.r.sync.run(); assert.equal((await f.store.load()).tasks[0].status, 'queued');
  assert.ok(!Object.values((await f.store.load()).linearSync)[0].cursor);
  const g = await fixture(); g.reply('receipt');
  const save = g.store.save.bind(g.store); let failed = false;
  g.store.save = async state => {
    if (!failed && Object.values(state.linearSync || {}).some(s => s.comments?.length)) { failed = true; throw new Error('Disk unavailable'); }
    return save(state);
  };
  await g.r.sync.run(); assert.equal((await g.store.load()).tasks[0].status, 'blocked');
  assert.ok(!Object.values((await g.store.load()).linearSync)[0].cursor);
  g.now += 31000; g.r = await g.make(); await g.r.sync.run();
  assert.equal((await g.store.load()).tasks[0].wakeups, 1);
});

test('GraphQL throttling honors reset and malformed pagination never returns a partial result', async () => {
  const reset = Date.now() + 180000;
  const limited = new LinearClient('synthetic', async () => ({ ok: true, headers: new Headers({ 'x-ratelimit-requests-reset': String(reset) }), json: async () => ({ errors: [{ extensions: { code: 'RATELIMITED' } }] }) }));
  await assert.rejects(limited.query('query { organization { id } }'), error => error.code === 'RATE_LIMITED' && error.retryAfterMs > 170000);
  let count = 0;
  const broken = new LinearClient('synthetic', async () => ({ ok: true, json: async () => { count++; return { data: { issues: { nodes: [{ id: 'partial' }], pageInfo: { hasNextPage: true, endCursor: 'same' } } } }; } }));
  await assert.rejects(broken.collection('issues', {}, 'id'), /pagination did not advance/);
  assert.equal(count, 2);
});

test('pagination, outage recovery and periodic reconciliation retain deduplication', async () => {
  const f = await fixture({ count: 0 }); f.pageSize = 1; f.addIssue('one', 'ready'); f.addIssue('two', 'ready');
  await f.r.sync.run(); assert.equal((await f.store.load()).tasks.length, 2);
  f.now += 301000; f.fail = 'offline'; f.addIssue('three', 'ready'); await f.r.sync.run();
  f.now += 31000; f.fail = ''; await f.r.sync.run(); assert.equal((await f.store.load()).tasks.length, 3);
  f.addIssue('late', 'ready').updatedAt = '2020-01-01T00:00:00Z';
  f.now += 901000; await f.r.sync.run(); assert.equal((await f.store.load()).tasks.length, 4);
  await f.r.sync.run({ force: true }); assert.equal((await f.store.load()).tasks.length, 4);
});

test('changed configuration during fetch discards results and old cursors', async () => {
  const f = await fixture(); let release, enter; const entered = new Promise(resolve => { enter = resolve; });
  f.r.linearFactory = () => ({ changes: async () => { enter(); return new Promise(resolve => { release = resolve; }); } });
  const running = f.r.sync.run(); await entered;
  await f.r.dispatcher.update(s => { s.settings.projects[0].linear.enabled = false; });
  release({ issues: [], comments: [f.reply('unexpected')], watched: f.issues, until: new Date(f.now).toISOString() }); await running;
  assert.equal((await f.store.load()).linearSync, undefined); assert.equal((await f.store.load()).tasks[0].status, 'blocked');
});

test('local timer runs while remote sync is in backoff and stopped/reassigned issues cannot wake', async () => {
  const f = await fixture(); f.fail = 'offline'; await f.r.sync.run();
  await f.r.dispatcher.update(s => { const t = s.tasks[0]; delete t.issue; t.wait = { ...t.wait, kind: 'time', status: 'watching', notBefore: '2000-01-01T00:00:00Z' }; });
  await f.r.monitor({ localOnly: true }); // failed remote read keeps a short timer retry delay
  await f.r.dispatcher.update(s => { delete s.tasks[0].wait.error; });
  await f.r.monitor({ localOnly: true }); assert.equal((await f.store.load()).tasks[0].status, 'queued');
  const g = await fixture(); g.reply('receipt'); g.issues[0].assignee.id = 'someone-else'; await g.r.sync.run();
  assert.equal((await g.store.load()).tasks[0].status, 'blocked'); assert.equal(g.starts, 1);
});
