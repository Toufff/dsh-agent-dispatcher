// End-to-end acceptance scenarios (a)-(j): real Runtime cycles + FileStore restarts + real LinearClient over a
// synthetic Linear world + fake executor. See harness.js. No network, no production store.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { writeFile } from 'node:fs/promises';
import { world, botLinear, forbidNetwork, restoreNetwork, sleep, FakeExecutor } from './harness.js';

before(forbidNetwork);
after(restoreNetwork);
const ready = (w, id, extra = {}) => w.linear.issue(id, { identifier: id.toUpperCase(), assignee: { id: 'touf' }, ...extra });

test('(a)+(b) a user stop sticks through comment wake, data wake, interrupted restart and a new dispatch round; unhold restores', async () => {
  const dataFile = path.join(os.tmpdir(), `dispatch-accept-ver-${process.pid}.txt`);
  const w = await world({ settings: s => { s.projects[0].followup.dataVersionFile = dataFile; return s; } });
  await writeFile(dataFile, 'v1');
  try {
    // ex-1: blocked on data, then stopped by the user. ex-2: identical control, not stopped. ex-3: running, stop unconfirmed.
    ready(w, 'ex-1'); ready(w, 'ex-2'); ready(w, 'ex-3');
    w.executor.script('EX-1', 'blocked'); w.executor.script('EX-2', 'blocked'); w.executor.script('EX-3', 'run');
    await w.cycle(2);
    assert.deepEqual(['EX-1', 'EX-2', 'EX-3'].map(i => w.executor.started(i)), [1, 1, 1]);
    assert.equal((await w.last('EX-1')).status, 'blocked');
    const t1 = await w.last('EX-1');
    await w.runtime.command({ action: 'stop', id: t1.id, reason: '方向错了' });
    assert.equal((await w.last('EX-1')).hold?.by, 'user');
    // Comment wake: a trusted collaborator comments on both blocked issues.
    await sleep(5);
    w.linear.comment('ex-1', 'peer', '继续'); w.linear.comment('ex-2', 'peer', '继续');
    await w.cycle(2);
    assert.equal((await w.tasks('EX-1')).length, 1, 'comment must not resume the held task');
    assert.ok((await w.tasks('EX-2')).length >= 2, 'control: the unheld task is woken by the comment');
    // Data wake.
    await writeFile(dataFile, 'v2'); await w.cycle(2);
    assert.equal((await w.tasks('EX-1')).length, 1, 'data wake must not resume the held task');
    // Interrupted restart: stop of a running turn is unconfirmed, the host restarts, the turn comes back interrupted.
    const t3 = await w.last('EX-3');
    w.executor.stopReply = 'unknown';
    await w.runtime.command({ action: 'stop', id: t3.id });
    w.executor.stopReply = 'stopped';
    assert.equal((await w.last('EX-3')).hold?.by, 'user');
    await w.restart();
    w.executor.interrupt('EX-3');
    await w.cycle(3);
    let s3 = await w.last('EX-3');
    assert.equal(s3.status, 'stopped'); assert.equal(w.executor.started('EX-3'), 1, 'interrupted held turn never requeued');
    // New dispatch round (round bump): held issues take no new round, unheld ones do.
    await w.runtime.dispatcher.update(s => { s.settings.projects[0].linear.round = '2'; });
    for (const id of ['ex-1', 'ex-2', 'ex-3']) w.linear.touch(id, { state: { id: 'todo', type: 'unstarted' } });
    await w.cycle(2);
    assert.equal((await w.tasks('EX-1')).length, 1); assert.equal((await w.tasks('EX-3')).length, 1);
    assert.deepEqual([w.executor.started('EX-1'), w.executor.started('EX-3')], [1, 1]);
    // Restart again: holds are durable.
    await w.restart(); await w.cycle(2);
    assert.deepEqual([(await w.last('EX-1')).hold?.by, (await w.last('EX-3')).hold?.by], ['user', 'user']);
    // (b) unhold restores: EX-1 resumes (unseen comment / new round), EX-3 takes the new round.
    await w.runtime.command({ action: 'unhold', id: t1.id });
    await w.runtime.command({ action: 'unhold', id: s3.id });
    w.linear.touch('ex-1'); w.linear.touch('ex-3');
    await w.cycle(3);
    assert.ok(w.executor.started('EX-1') >= 2, 'unheld EX-1 runs again');
    assert.ok(w.executor.started('EX-3') >= 2, 'unheld EX-3 runs again');
    assert.deepEqual(w.linear.unknown, []);
  } finally { await w.close(); await import('node:fs/promises').then(f => f.rm(dataFile, { force: true })); }
});

test('(c) focus on two issues: related child runs, unrelated held, uncertain pending; focus-clear releases focus holds only', async () => {
  const verdicts = { 'EX-12': 'unrelated', 'EX-13': 'uncertain' };
  const w = await world({ focusJudge: input => ({ verdict: verdicts[input.candidate.identifier] || 'uncertain', reason: `stub ${input.candidate.identifier}` }) });
  try {
    ready(w, 'ex-14'); w.executor.script('EX-14', 'blocked');
    await w.cycle(2);
    const t14 = await w.last('EX-14');
    await w.runtime.command({ action: 'stop', id: t14.id, reason: 'user stop' });
    await w.runtime.command({ action: 'focus-set', issues: ['EX-10', 'EX-20'], intent: '只跑两张' });
    ready(w, 'ex-10', { children: ['ex-11'] }); ready(w, 'ex-11', { parent: 'ex-10' });
    ready(w, 'ex-12'); ready(w, 'ex-13'); ready(w, 'ex-20');
    await w.cycle(4);
    const snap = await w.snap();
    assert.deepEqual(['EX-10', 'EX-20', 'EX-11', 'EX-12', 'EX-13'].map(i => w.executor.started(i)), [1, 1, 1, 0, 0]);
    const t11 = await w.last('EX-11');
    assert.equal(t11.events.find(e => e.action === 'focus-judged')?.rule, 'parent');
    assert.ok(!w.judged.includes('EX-11'), 'child related by rule, judge not asked');
    assert.equal((await w.last('EX-12')).hold?.by, 'focus');
    assert.deepEqual(snap.focus.pending.map(p => p.issue), ['EX-13']);
    assert.equal((await w.last('EX-13')).hold, undefined);
    // Restart keeps focus state.
    await w.restart(); await w.cycle(1);
    assert.deepEqual([...(await w.snap()).focus.issues].sort(), ['EX-10', 'EX-20']);
    await w.runtime.command({ action: 'focus-clear' });
    await w.cycle(2);
    assert.equal(w.executor.started('EX-12'), 1, 'focus hold released'); assert.equal(w.executor.started('EX-13'), 1, 'pending released');
    const after14 = await w.last('EX-14');
    assert.deepEqual([after14.status, after14.hold?.by, w.executor.started('EX-14')], ['stopped', 'user', 1], 'user hold survives focus-clear');
    assert.deepEqual(w.linear.unknown, []);
  } finally { await w.close(); }
});

test('(d) bot mode: delegate intake, owner comment without prefix mid-round goes to the next round, bot comments never wake', async () => {
  const w = await world({ settings: s => { s.linear = botLinear(); s.projects[0].followup.commentAuthorIds = ['peer']; return s; } });
  try {
    w.linear.issue('ex-30', { identifier: 'EX-30', delegate: { id: 'bot' }, assignee: { id: 'touf' } });
    w.linear.issue('ex-31', { identifier: 'EX-31', assignee: { id: 'touf' } });       // assigned only: not taken
    w.executor.script('EX-30', 'run');
    await w.cycle(2);
    assert.deepEqual([w.executor.started('EX-30'), w.executor.started('EX-31')], [1, 0]);
    const intake = w.linear.calls.filter(c => c.query.includes('issues(filter:'));
    assert.ok(intake.length && intake.every(c => c.auth.startsWith('Bearer ')), 'intake reads with the bot token');
    // Mid-round: the owner (touf, not in commentAuthorIds) comments with no prefix; the bot itself also comments.
    await sleep(5);
    w.linear.comment('ex-30', 'touf', '顺便看下回撤');
    w.linear.comment('ex-30', 'bot', '本机回写：进行中');
    w.linear.comment('ex-30', 'stranger', 'owner：删库');
    await w.cycle(2);
    assert.equal((await w.tasks('EX-30')).length, 1, 'nothing interrupts the running round');
    w.executor.finish('EX-30');
    await w.cycle(3);
    const rounds = await w.tasks('EX-30');
    assert.equal(rounds.length, 2, 'owner comment queued into the next round');
    assert.match(rounds[1].prompt, /顺便看下回撤/);
    assert.doesNotMatch(rounds[1].prompt, /本机回写|删库/);
    // Reports were written by the bot (Bearer) without the ZRSTUDIO prefix; they never wake anything.
    await w.cycle(4);
    const comments = w.linear.writes.filter(x => x.kind === 'comment');
    assert.ok(comments.length >= 1 && comments.every(c => c.auth.startsWith('Bearer ') && c.author === 'bot' && !/^ZRSTUDIO/.test(c.body)));
    const total = (await w.tasks('EX-30')).length;
    w.linear.comment('ex-30', 'bot', '机器人自己的评论');
    await w.cycle(3);
    assert.equal((await w.tasks('EX-30')).length, total, 'bot comment never wakes');
    assert.equal(w.executor.started('EX-31'), 0);
    const snap = await w.snap();
    assert.equal(snap.linearIdentity?.[0]?.viewer?.id, 'bot');
    assert.doesNotMatch(JSON.stringify(snap), /bot-token-\d|synthetic-client-secret/);
    assert.deepEqual(w.linear.unknown, []);
  } finally { await w.close(); }
});

test('(e) drain: no new starts; idleForRestart becomes true after the running turn ends', async () => {
  const w = await world();
  try {
    ready(w, 'ex-40'); w.executor.script('EX-40', 'run');
    await w.cycle(2);
    await w.runtime.command({ action: 'drain', reason: 'restart host' });
    ready(w, 'ex-41');
    let snap = await w.cycle(2);
    assert.equal(snap.restart.idleForRestart, false);
    assert.equal(w.executor.started('EX-41'), 0); assert.equal((await w.tasks('EX-41')).length, 0);
    w.executor.finish('EX-40');
    snap = await w.cycle(2);
    assert.equal(snap.restart.idleForRestart, true);
    assert.equal(w.executor.started('EX-41'), 0);
    await w.restart(); snap = await w.cycle(1);
    assert.equal(snap.drain.on, true, 'drain persists across restart');
    await w.runtime.command({ action: 'undrain' }); w.linear.touch('ex-41');
    await w.cycle(2);
    assert.equal(w.executor.started('EX-41'), 1);
  } finally { await w.close(); }
});

test('(f) an unknown settings key is accepted, reported and survives restart', async () => {
  const w = await world();
  try {
    let snap = await w.snap();
    const settings = structuredClone(snap.settings); settings.futureFlag = { mode: 'x' };
    snap = await w.runtime.command({ action: 'configure', settings, revision: snap.revision });
    assert.deepEqual(snap.settingsUnknownKeys, ['futureFlag']);
    await w.restart();
    snap = await w.cycle(1);
    assert.deepEqual(snap.settings.futureFlag, { mode: 'x' }); assert.deepEqual(snap.settingsUnknownKeys, ['futureFlag']);
  } finally { await w.close(); }
});

test('(g) merged exit: a cycle of five finishing tasks and director writes reaches Linear as aliased batches; restart keeps queued writes', async () => {
  const w = await world();
  try {
    for (const id of ['mx-1', 'mx-2', 'mx-3', 'mx-4', 'mx-5']) ready(w, id);
    await w.cycle(1);
    // The cache learned the issues from the sync and from its own write results: the view needs no request.
    const calls = w.linear.calls.length;
    const view = await w.runtime.command({ action: 'linear-view', include: ['issues'] });
    assert.ok(view.issues.some(i => i.identifier === 'MX-1')); assert.equal(w.linear.calls.length, calls);
    const queued = await w.runtime.command({ action: 'linear-enqueue', caller: 'director', idempotencyKey: 'mx-review', op: { kind: 'comment', issue: 'mx-1', body: '复审意见' } });
    await w.restart();
    const before = w.linear.calls.length, batchesBefore = w.linear.batches || 0;
    await w.cycle(2);
    const writes = w.linear.calls.slice(before).filter(c => c.query.startsWith('mutation('));
    assert.equal(writes.length, (w.linear.batches || 0) - batchesBefore, 'every write left as one aliased mutation request');
    assert.ok(writes.length <= 2, `write requests: ${writes.length}`);
    assert.ok(!w.linear.calls.some(c => /mutation\(\$input/.test(c.query)), 'no single-write mutation');
    assert.equal(w.linear.writes.filter(x => x.id === queued.id).length, 1);
    assert.equal((await w.runtime.command({ action: 'linear-result', ids: [queued.id] }))[0].status, 'sent');
    for (const id of ['MX-1', 'MX-2', 'MX-3', 'MX-4', 'MX-5']) assert.equal((await w.last(id)).report, 'sent');
  } finally { await w.close(); }
});

// ---- (h)-(j): merged-exit batching at scale, stale host.lock takeover, busy residue cleanup ----

test('(h) batching: ten finishing tasks + director enqueues leave as <= 2 aliased requests; per-item results are exact', async () => {
  const w = await world({ settings: s => { s.concurrency = 10; s.projects[0].maxConcurrent = 10; s.projects[0].linear.teamId = 'team'; return s; } });
  try {
    const ids = Array.from({ length: 10 }, (_, i) => `hx-${i + 1}`);
    for (const id of ids) ready(w, id);
    await w.cycle(1);   // intake: the sync fills the cache (identifiers become resolvable)
    let once = true;
    w.linear.failAlias = (kind, input) => kind === 'commentCreate' && input.body === '被拒一次' && once && !(once = false);
    const enq = op => w.runtime.command({ action: 'linear-enqueue', caller: 'director', idempotencyKey: JSON.stringify(op), op });
    const q = {
      review: await enq({ kind: 'comment', issue: 'HX-1', body: '复审：通过' }),
      label: await enq({ kind: 'issueUpdate', issue: 'HX-2', input: { labelIds: ['lbl-1'] } }),
      create: await enq({ kind: 'issueCreate', input: { title: '研究主管新方向', description: '正文' } }),
      flaky: await enq({ kind: 'comment', issue: 'HX-3', body: '被拒一次' }),
    };
    assert.ok(Object.values(q).every(r => r.status === 'queued'));
    assert.equal((await enq({ kind: 'comment', issue: 'HX-1', body: '复审：通过' })).status, 'duplicate');
    const before = w.linear.calls.length, batches = w.linear.batches || 0;
    await w.cycle(2);
    const writes = w.linear.calls.slice(before).filter(c => c.query.startsWith('mutation('));
    assert.equal(writes.length, (w.linear.batches || 0) - batches, 'only aliased mutations');
    assert.ok(writes.length <= 2, `write requests: ${writes.length}`);
    const reports = w.linear.writes.filter(x => x.kind === 'comment' && ids.includes(x.issueId));
    assert.ok(reports.length >= 10, `report comments: ${reports.length}`);
    for (const id of ids) assert.equal((await w.last(id.toUpperCase())).report, 'sent');
    let res = Object.fromEntries((await w.runtime.command({ action: 'linear-result', ids: Object.values(q).map(r => r.id) })).map(r => [r.id, r]));
    assert.equal(res[q.review.id].status, 'sent'); assert.ok(res[q.review.id].result.commentId);
    assert.equal(w.linear.writes.find(x => x.id === q.review.id).issueId, 'hx-1', 'identifier resolved to the cached issue id');
    assert.equal(res[q.label.id].status, 'sent'); assert.equal(res[q.label.id].result.issueIdentifier, 'HX-2');
    assert.equal(res[q.create.id].status, 'sent'); assert.match(res[q.create.id].result.issueIdentifier, /^NEW-\d+$/);
    assert.equal(res[q.flaky.id].status, 'retrying'); assert.match(res[q.flaky.id].error, /拒绝/);
    // The rejected alias retries alone (after a check read), exactly once on Linear.
    await w.runtime.dispatcher.update(s => { for (const i of s.outbox) if (i.status === 'pending') i.nextAt = 0; });
    const b2 = w.linear.batches;
    await w.cycle(1);
    assert.equal(w.linear.batches - b2, 1);
    res = (await w.runtime.command({ action: 'linear-result', ids: [q.flaky.id] }))[0];
    assert.equal(res.status, 'sent');
    assert.equal(w.linear.writes.filter(x => x.body === '被拒一次').length, 1);
    assert.equal(w.linear.writes.filter(x => x.kind === 'create').length, 1, 'issue created once');
    const usage = (await w.snap()).linearUsage;
    assert.ok(usage, 'snapshot carries linearUsage');
    assert.deepEqual(w.linear.unknown, []);
  } finally { await w.close(); }
});

test('(i) a stale host.lock in a runtime dir is taken over with the real process probe; a live owner is refused', async () => {
  const { acquireLease, selfProcess } = await import('../../src/host-lease.js');
  const { spawn } = await import('node:child_process');
  const { mkdtemp, readFile, rm, writeFile: write } = await import('node:fs/promises');
  const d = await mkdtemp(path.join(os.tmpdir(), 'dispatch-accept-lock-'));
  try {
    // A real process that has exited: its pid is dead.
    const child = spawn(process.execPath, ['-e', '0']);
    const deadPid = child.pid; await new Promise(r => child.on('exit', r));
    await write(path.join(d, 'host.lock'), JSON.stringify({ pid: deadPid, startedAt: new Date(Date.now() - 3_600_000).toISOString() }));
    const logs = [];
    let release = await acquireLease(d, { log: m => logs.push(m) });
    const lock = JSON.parse(await readFile(path.join(d, 'host.lock'), 'utf8'));
    assert.equal(lock.pid, process.pid); assert.ok(lock.processStartedAt);
    const audit = (await readFile(path.join(d, 'host-lock-audit.log'), 'utf8')).trim().split('\n').map(l => JSON.parse(l));
    assert.equal(audit.length, 1); assert.equal(audit[0].reason, 'owner-dead'); assert.equal(audit[0].previous.pid, deadPid);
    assert.equal(logs.length, 1);
    // A second host while this (live, same start time) process holds it: refused with the real probe.
    await assert.rejects(acquireLease(d, { self: { pid: 999_999, processStartedAt: new Date().toISOString() } }), /host lock exists \(owner alive/);
    await release();
    // Windows PID reuse: the live pid (this process) recorded with another start time.
    await write(path.join(d, 'host.lock'), JSON.stringify({ pid: process.pid, startedAt: new Date(Date.now() - 86_400_000).toISOString(),
      processStartedAt: new Date(Date.parse(selfProcess().processStartedAt) - 86_400_000).toISOString() }));
    release = await acquireLease(d, { self: { pid: 999_998, processStartedAt: new Date().toISOString() } });
    const audit2 = (await readFile(path.join(d, 'host-lock-audit.log'), 'utf8')).trim().split('\n').map(l => JSON.parse(l));
    assert.equal(audit2.at(-1).reason, 'pid-reused');
    await release();
  } finally { await rm(d, { recursive: true, force: true }); }
});

test('(j) busy residue: an idle session held only by system notices is cleared after the threshold and the task runs; an ambiguous queue is left and reported', async () => {
  const { DshAdapter } = await import('../../src/adapters/dsh.js');
  const clock = { t: Date.now() };
  const notice = (id, kind) => ({ id, source: { kind }, content: [] });
  const agents = new Map([
    ['s-JX-1', { status: 'idle', removed: [], inbox: { nextTurn: [notice('n1', 'tool-jobs'), notice('n2', 'runtime-context')], nextStep: [] } }],
    ['s-JX-2', { status: 'idle', removed: [], inbox: { nextTurn: [notice('n3', 'tool-jobs'), { id: 'u1', source: { kind: 'user', rpcId: 'manual' }, content: [] }], nextStep: [] } }],
  ]);
  for (const a of agents.values()) a.inbox.remove = function (id) { a.removed.push(id); this.nextTurn = this.nextTurn.filter(m => m.id !== id); };
  const dsh = new DshAdapter({ agents: { get: id => agents.get(id) } }, { residualNoticeMinutes: 10 }, { now: () => clock.t });
  class ResidueExecutor extends FakeExecutor {
    adapter() {
      const base = super.adapter(), busyOnce = new Set(['JX-1', 'JX-2']);
      return { ...base,
        start: async input => {
          const identifier = input.task.issue?.identifier;
          if (busyOnce.delete(identifier)) return { status: 'busy', reason: 'Session already has active or queued work', sessionId: `s-${identifier}` };
          return base.start(input);
        },
        reconcile: async arg => arg.attempt.status === 'busy' ? dsh.reconcile(arg) : base.reconcile(arg) };
    }
  }
  const executor = new ResidueExecutor();
  const w = await world({ executor });
  try {
    ready(w, 'jx-1'); ready(w, 'jx-2');
    await w.cycle(2);
    assert.equal((await w.last('JX-1')).status, 'busy'); assert.equal((await w.last('JX-2')).status, 'busy');
    clock.t += 9 * 60_000; await w.cycle(1);
    assert.deepEqual(agents.get('s-JX-1').removed, [], 'nothing removed before the threshold');
    clock.t += 2 * 60_000; await w.cycle(3);
    assert.deepEqual(agents.get('s-JX-1').removed, ['n1', 'n2']);
    const t1 = await w.last('JX-1');
    assert.ok(t1.events.some(e => e.action === 'residual-notices-cleared'));
    assert.notEqual(t1.status, 'busy', 'the task left busy and ran');
    assert.ok(executor.started('JX-1') >= 1);
    const t2 = await w.last('JX-2');
    assert.equal(t2.status, 'busy'); assert.deepEqual(agents.get('s-JX-2').removed, [], 'ambiguous queue untouched');
    assert.ok(t2.events.some(e => e.action === 'residual-queue-ambiguous'));
    assert.ok((await w.snap()).errors.some(e => /user@nextTurn/.test(e)));
  } finally { await w.close(); }
});
