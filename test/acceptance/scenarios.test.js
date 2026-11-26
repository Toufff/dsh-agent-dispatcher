// End-to-end acceptance scenarios (a)-(f): real Runtime cycles + FileStore restarts + real LinearClient over a
// synthetic Linear world + fake executor. See harness.js. No network, no production store.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { writeFile } from 'node:fs/promises';
import { world, botLinear, forbidNetwork, restoreNetwork, sleep } from './harness.js';

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
