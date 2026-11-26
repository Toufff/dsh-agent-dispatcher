// Focus mode: only issues in focus (or judged related) start; unrelated work is held, not lost.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { MemoryStore } from '../src/dispatcher.js';
import { initialState } from '../src/config.js';
import { Runtime } from '../src/runtime.js';
import { FileStore } from '../src/store.js';
import { relatedByRules, handoverIssues, mentionedIssues, normalizeIssues, focusDecision } from '../src/focus.js';
import { commandJudge, parseJudgeOutput } from '../src/focus-judge.js';
import { workItems } from './workflow-fixtures.js';

const done = `<dispatch-result>${JSON.stringify({ status: 'complete', workItems: workItems('complete'), evidence: ['ok'], remaining: [], next: '', progress: 'done', blockers: [] })}</dispatch-result>`;
const later = () => new Date(Date.now() + 1000).toISOString();

// ---------- rules (pure) ----------
const F = (issues, contexts) => ({ issues, contexts });
const C = fields => ({ identifier: 'LON-50', title: '', description: '', comments: [], parent: null, children: [], chain: [], ...fields });
const RULES = [
  ['in focus list', F(['LON-50']), C({}), 'focus-list', 'LON-50'],
  ['continuation chain', F(['LON-35']), C({ chain: ['LON-35'] }), 'chain', 'LON-35'],
  ['parent in focus', F(['LON-35']), C({ parent: 'LON-35' }), 'parent', 'LON-35'],
  ['child in focus', F(['LON-60']), C({ children: ['LON-61', 'LON-60'] }), 'child', 'LON-60'],
  ['focus issue is its child (focus context)', F(['LON-70'], { 'LON-70': { parent: 'LON-50' } }), C({}), 'child', 'LON-70'],
  ['focus issue is its parent (focus context)', F(['LON-71'], { 'LON-71': { children: ['LON-50'] } }), C({}), 'parent', 'LON-71'],
  ['handover in candidate: 接管', F(['LON-35']), C({ description: '本单接管 LON-35 台账 r399-h581' }), 'handover', 'LON-35'],
  ['handover in candidate comment: 移交', F(['LON-40']), C({ comments: ['这部分移交 LON-40 处理'] }), 'handover', 'LON-40'],
  ['handover in focus issue: split_issue', F(['LON-35'], { 'LON-35': { description: '{"id":"r245-h338","split_issue": "LON-50"}' } }), C({}), 'handover', 'LON-35'],
  ['mention in title', F(['LON-28']), C({ title: 'LON-50 · LON-28 现役复核' }), 'mention', 'LON-28'],
  ['mention in comments', F(['LON-28']), C({ comments: ['参考 LON-28 的结果'] }), 'mention', 'LON-28'],
  ['no relation', F(['LON-28']), C({ title: 'LON-50 · 板块轮动', description: '无关内容 LON-280 LON-2' }), null, null],
  ['identifier prefix is not a mention (LON-3 vs LON-35)', F(['LON-3']), C({ description: '见 LON-35 与 XLON-3' }), null, null],
  ['self mention does not count', F(['LON-99']), C({ description: 'LON-50 自己' }), null, null],
];
for (const [name, focus, candidate, rule, via] of RULES) {
  test(`rules: ${name}`, () => {
    const got = relatedByRules({ focus, candidate });
    if (!rule) return assert.equal(got, null);
    assert.equal(got.verdict, 'related'); assert.equal(got.rule, rule); assert.equal(got.via, via); assert.ok(got.reason);
  });
}
test('rules: marker and mention extraction, identifier normalization', () => {
  assert.deepEqual([...handoverIssues('拆单记录：r245-h338 中军容量腿 → LON-45；接管 LON-35 台账；hand over to ABC-7')].sort(), ['ABC-7', 'LON-35']);
  assert.deepEqual([...mentionedIssues('LON-35,LON-3 x-LON-4 LON-12a')].sort(), ['LON-3', 'LON-35']);
  assert.deepEqual(normalizeIssues([' lon-35', 'LON-35', 'LON-160']), ['LON-35', 'LON-160']);
  assert.throws(() => normalizeIssues(['35']));
});

// ---------- runtime fixture ----------
async function fixture({ comments = () => [], judge, start, store = new MemoryStore(), linear = {}, seed = true } = {}) {
  if (seed) {
    const state = initialState();
    state.paused = false; state.settings.concurrency = 4;
    state.settings.projects = [{ id: 'p', label: 'Example', cwd: process.cwd(), maxConcurrent: 4,
      linear: { enabled: true, tokenEnv: 'TEST_TOKEN', workspaceId: 'w', assigneeId: 'me', round: '1', reviewStateId: 'review', readyStateId: 'ready' },
      followup: { enabled: true, commentAuthorIds: ['peer', 'me'], maxWakeups: 8, reviewComments: true } }];
    await store.save(state);
  }
  const judged = [];
  const runtime = await new Runtime({ store, directory: os.tmpdir(), env: { TEST_TOKEN: 'synthetic' },
    focusJudge: async input => { judged.push(input); return judge ? judge(input) : { verdict: 'uncertain', reason: 'stub' }; },
    linearFactory: () => ({ eligible: async () => ({}), activity: async () => ({ comments: comments() }), issues: async () => [], report: async () => {}, ...linear }) }).init();
  const starts = [];
  runtime.adapters.codex = { start: async input => { starts.push(input.task.issue?.identifier); return start ? start(input) : { status: 'review', summary: done, sessionId: `s-${starts.length}` }; },
    stop: async () => ({ status: 'stopped' }), reconcile: async () => ({ status: 'running' }) };
  return { runtime, starts, judged, store };
}
const submit = (runtime, n, extra = {}) => runtime.submit({ projectId: 'p', prompt: extra.prompt || 'Work', title: extra.title || `EX-${n} · task`,
  issue: { id: `issue-${n}`, identifier: `EX-${n}` }, source: `w/issue-${n}` });
/** One cycle's focus pass, the evaluation it started, and a tick. */
async function step(runtime) {
  await runtime.focusPass(); await runtime.focusJudging; await runtime.focusPass();
  await runtime.dispatcher.tick(); await runtime.assess();
}
const taskOf = async (runtime, identifier) => (await runtime.snapshot()).tasks.filter(t => t.issue?.identifier === identifier).at(-1);

test('focus: an issue in focus starts with an audited rule reason; others are not started', async () => {
  const { runtime, starts, judged } = await fixture();
  await runtime.command({ action: 'focus-set', issues: ['EX-1'], intent: '只跑 EX-1' });
  await submit(runtime, 1); await submit(runtime, 2);
  await step(runtime);
  assert.deepEqual(starts, ['EX-1']);
  const t1 = await taskOf(runtime, 'EX-1');
  assert.equal(t1.events.find(e => e.action === 'focus-start').rule, 'focus-list');
  assert.equal(judged.length, 1, 'only the unrelated candidate goes to the judge');
  assert.equal(judged[0].candidate.identifier, 'EX-2');
  assert.deepEqual(judged[0].focus, { issues: ['EX-1'], intent: '只跑 EX-1' });
});

test('judge: related starts, unrelated is held by focus, uncertain waits for confirmation', async () => {
  const verdicts = { 'EX-2': 'related', 'EX-3': 'unrelated', 'EX-4': 'uncertain' };
  const { runtime, starts } = await fixture({ judge: input => ({ verdict: verdicts[input.candidate.identifier], reason: `stub ${input.candidate.identifier}` }) });
  await runtime.command({ action: 'focus-set', issues: ['EX-1'] });
  for (const n of [2, 3, 4]) await submit(runtime, n);
  for (let i = 0; i < 4; i++) await step(runtime);
  assert.deepEqual(starts, ['EX-2']);
  const snap = await runtime.snapshot();
  const t3 = snap.tasks.find(t => t.issue.identifier === 'EX-3'), t4 = snap.tasks.find(t => t.issue.identifier === 'EX-4');
  assert.equal(t3.status, 'queued'); assert.deepEqual([t3.hold.by, t3.hold.reason], ['focus', 'stub EX-3']);
  assert.ok(t3.events.some(e => e.action === 'focus-held'));
  assert.equal(t4.hold, undefined);
  assert.deepEqual(snap.focus.pending.map(p => [p.issue, p.verdict, p.reason]), [['EX-4', 'uncertain', 'stub EX-4']]);
  assert.deepEqual(snap.focus.held.map(h => h.issue), ['EX-3']);
  const explained = await runtime.command({ action: 'explain', id: t4.id });
  assert.equal(explained.focus.decision.verdict, 'pending');
  assert.ok(explained.runnable.reasons.some(r => /待 owner 确认/.test(r)));
  const e3 = await runtime.command({ action: 'explain', id: t3.id });
  assert.ok(e3.focus.heldByFocus); assert.ok(e3.focus.events.some(e => e.action === 'focus-held'));
  // focus-approve releases the pending one and adds its chain to focus.
  await runtime.command({ action: 'focus-approve', issue: 'EX-4' });
  await step(runtime);
  assert.deepEqual(starts, ['EX-2', 'EX-4']);
  assert.ok((await runtime.snapshot()).focus.issues.includes('EX-4'));
});

test('judge: an error or timeout never starts the task; it is listed for confirmation; reject keeps it held', async () => {
  const { runtime, starts } = await fixture({ judge: input => {
    if (input.candidate.identifier === 'EX-2') throw new Error('gateway 403');
    return new Promise((_, reject) => setTimeout(() => reject(new Error('判定超时（1000 ms）')), 5));
  } });
  await runtime.command({ action: 'focus-set', issues: ['EX-1'] });
  await submit(runtime, 2); await submit(runtime, 3);
  for (let i = 0; i < 3; i++) await step(runtime);
  assert.deepEqual(starts, []);
  let snap = await runtime.snapshot();
  assert.deepEqual(snap.focus.pending.map(p => [p.issue, p.verdict]).sort(), [['EX-2', 'error'], ['EX-3', 'error']]);
  assert.match(snap.focus.pending.find(p => p.issue === 'EX-2').reason, /403/);
  await runtime.command({ action: 'focus-reject', issue: 'EX-2' });
  await step(runtime);
  snap = await runtime.snapshot();
  assert.equal(snap.tasks.find(t => t.issue.identifier === 'EX-2').hold.by, 'focus');
  assert.deepEqual(snap.focus.pending.map(p => p.issue), ['EX-3']);
  assert.deepEqual(starts, []);
});

test('command judge: real child process, related / bad output / timeout; secrets removed from its env', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'focus-judge-'));
  try {
    const script = path.join(dir, 'judge.mjs');
    await writeFile(script, `let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const i=JSON.parse(s);
      if(i.candidate.identifier==='SLOW-1') setTimeout(()=>{},10000);
      else if(i.candidate.identifier==='BAD-1') console.log('not json');
      else console.log(JSON.stringify({verdict:'related',reason:'saw '+i.focus.issues.join(',')+' token='+(process.env.TEST_TOKEN||'none')}));});`);
    const settings = { focus: { judge: { command: process.execPath, args: [script], timeoutMs: 1500 } } };
    const input = id => ({ focus: { issues: ['EX-1'], intent: '' }, candidate: { identifier: id } });
    const ok = await commandJudge(input('EX-2'), { settings, env: { ...process.env, TEST_TOKEN: 'secret' }, secretKeys: ['TEST_TOKEN'] });
    assert.deepEqual(ok, { verdict: 'related', reason: 'saw EX-1 token=none' });
    await assert.rejects(commandJudge(input('BAD-1'), { settings }), /JSON/);
    await assert.rejects(commandJudge(input('SLOW-1'), { settings }), /超时/);
    await assert.rejects(commandJudge(input('EX-2'), { settings: {} }), /未配置/);
    assert.equal(parseJudgeOutput('log line\n{"verdict":"unrelated","reason":"r"}').verdict, 'unrelated');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('rules from Linear context (parent) relate a candidate without asking the judge', async () => {
  const { runtime, starts, judged } = await fixture({ linear: { focusContext: async ref => ref === 'issue-2'
    ? { identifier: 'EX-2', title: 'child', description: '', parent: 'EX-1', children: [], comments: [] } : null } });
  await runtime.command({ action: 'focus-set', issues: ['EX-1'] });
  await submit(runtime, 2);
  await step(runtime); await step(runtime);
  assert.deepEqual(starts, ['EX-2']);
  assert.equal(judged.length, 0);
  const t = await taskOf(runtime, 'EX-2');
  assert.equal(t.events.find(e => e.action === 'focus-judged').rule, 'parent');
});

test('a running unrelated task finishes its turn; the comment-woken next round is queued and held, not started', async () => {
  const at = later();
  let reconcileAs = 'running', comment = [];
  const { runtime, starts } = await fixture({ comments: () => comment, judge: () => ({ verdict: 'unrelated', reason: 'other topic' }),
    start: () => ({ status: 'running', sessionId: 's1' }) });
  runtime.adapters.codex.reconcile = async () => reconcileAs === 'running' ? { status: 'running' } : { status: 'review', summary: done };
  let stops = 0; runtime.adapters.codex.stop = async () => { stops++; return { status: 'stopped' }; };
  await submit(runtime, 5);
  await runtime.dispatcher.tick();
  assert.deepEqual(starts, ['EX-5']);
  await runtime.command({ action: 'focus-set', issues: ['EX-1'] });
  await step(runtime);
  assert.equal((await taskOf(runtime, 'EX-5')).status, 'running', 'focus does not interrupt the running turn');
  reconcileAs = 'review';
  await runtime.dispatcher.reconcile(); await runtime.assess();
  assert.equal(stops, 0);
  comment = [{ id: 'c1', body: 'keep going', createdAt: at, updatedAt: at, user: { id: 'peer' } }];
  await runtime.reviewComments();
  for (let i = 0; i < 3; i++) await step(runtime);
  const all = (await runtime.snapshot()).tasks.filter(t => t.issue.identifier === 'EX-5');
  assert.equal(all.length, 2, 'the comment created the next round (not lost)');
  assert.equal(all[1].status, 'queued'); assert.equal(all[1].hold.by, 'focus');
  assert.match(all[1].prompt, /keep going/);
  assert.deepEqual(starts, ['EX-5'], 'held round never started');
  // focus-clear restores prior behaviour: the held round starts.
  await runtime.command({ action: 'focus-clear' });
  await step(runtime);
  assert.deepEqual(starts, ['EX-5', 'EX-5']);
  const t = await taskOf(runtime, 'EX-5');
  assert.equal(t.hold, undefined);
  assert.ok(t.events.some(e => e.action === 'focus-release'));
});

test('focus-clear never undoes a user stop; a later explicit retry does', async () => {
  const { runtime, starts } = await fixture({ judge: () => ({ verdict: 'unrelated', reason: 'x' }) });
  await runtime.command({ action: 'focus-set', issues: ['EX-1'] });
  await submit(runtime, 2);
  await step(runtime);
  let t = await taskOf(runtime, 'EX-2');
  assert.equal(t.hold.by, 'focus');
  await runtime.command({ action: 'stop', id: t.id, reason: '不要了' });
  t = await taskOf(runtime, 'EX-2');
  assert.deepEqual([t.status, t.hold.by], ['stopped', 'user']);
  await runtime.command({ action: 'focus-clear' });
  await step(runtime);
  t = await taskOf(runtime, 'EX-2');
  assert.deepEqual([t.status, t.hold.by], ['stopped', 'user']);
  assert.deepEqual(starts, []);
});

test('owner retry in focus mode adds the issue to focus and it runs; automatic paths do not add', async () => {
  const { runtime, starts } = await fixture({ judge: () => ({ verdict: 'unrelated', reason: 'x' }) });
  await submit(runtime, 2);
  await runtime.dispatcher.tick(); await runtime.assess();
  const id = (await taskOf(runtime, 'EX-2')).id;
  await runtime.command({ action: 'stop', id });
  await runtime.command({ action: 'focus-set', issues: ['EX-1'] });
  await runtime.command({ action: 'retry', id });
  assert.deepEqual((await runtime.snapshot()).focus.issues, ['EX-1', 'EX-2']);
  await step(runtime);
  assert.deepEqual(starts, ['EX-2', 'EX-2']);
});

test('an interrupted turn of an unrelated task may finish after a restart', async () => {
  const { runtime, starts } = await fixture({ judge: () => ({ verdict: 'unrelated', reason: 'x' }), start: () => ({ status: 'running', sessionId: 's1' }) });
  await submit(runtime, 2);
  await runtime.dispatcher.tick();
  await runtime.command({ action: 'focus-set', issues: ['EX-1'] });
  runtime.adapters.codex.reconcile = async () => ({ status: 'interrupted', reason: 'host restart' });
  await runtime.dispatcher.reconcile();
  await step(runtime);
  assert.deepEqual(starts, ['EX-2', 'EX-2']);
  const t = await taskOf(runtime, 'EX-2');
  assert.equal(t.events.findLast(e => e.action === 'focus-start').rule, 'current-turn');
  assert.equal(t.interruptedTurn, undefined);
});

test('focus state, decisions and focus holds survive a restart (reloaded file store)', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dispatcher-focus-'));
  try {
    const store = await new FileStore(directory).open();
    const { runtime } = await fixture({ store, judge: () => ({ verdict: 'unrelated', reason: 'persisted reason' }) });
    await runtime.command({ action: 'focus-set', issues: ['EX-1'], intent: '今天只做 EX-1' });
    await submit(runtime, 2);
    await step(runtime);
    await store.close();
    const reopened = await new FileStore(directory).open();
    try {
      const { runtime: again, starts, judged } = await fixture({ store: reopened, seed: false });
      const snap = await again.snapshot();
      assert.deepEqual([snap.focus.enabled, snap.focus.issues, snap.focus.intent], [true, ['EX-1'], '今天只做 EX-1']);
      assert.deepEqual(snap.focus.decisions.map(d => [d.issue, d.verdict, d.reason]), [['EX-2', 'unrelated', 'persisted reason']]);
      const t = snap.tasks.find(x => x.issue.identifier === 'EX-2');
      assert.equal(t.hold.by, 'focus');
      await step(again);
      assert.deepEqual(starts, []); assert.equal(judged.length, 0, 'cached decision is reused, not re-judged');
    } finally { await reopened.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('no double start: a slow judge, repeated passes and ticks start a related task exactly once', async () => {
  let release;
  const gate = new Promise(r => { release = r; });
  const { runtime, starts, judged } = await fixture({ judge: async () => { await gate; return { verdict: 'related', reason: 'same topic' }; } });
  await runtime.command({ action: 'focus-set', issues: ['EX-1'] });
  await submit(runtime, 2);
  for (let i = 0; i < 5; i++) { await runtime.focusPass(); await runtime.dispatcher.tick(); }
  assert.deepEqual(starts, []); assert.equal(judged.length, 1, 'single-flight: one evaluation in flight');
  release();
  await runtime.focusJudging;
  await Promise.all([step(runtime), step(runtime), runtime.dispatcher.tick()]);
  await step(runtime);
  assert.deepEqual(starts, ['EX-2']);
  assert.equal(judged.length, 1);
  const t = await taskOf(runtime, 'EX-2');
  assert.equal(t.events.filter(e => e.action === 'focus-start').length, 1);
  assert.equal(t.events.find(e => e.action === 'focus-start').by, 'judge');
});

test('focus commands validate input and a focus change re-judges under the new revision', async () => {
  const { runtime, judged } = await fixture({ judge: () => ({ verdict: 'unrelated', reason: 'x' }) });
  await assert.rejects(runtime.command({ action: 'focus-add', issues: ['EX-1'] }), /focus-set/);
  await assert.rejects(runtime.command({ action: 'focus-set', issues: [] }), /at least one/);
  await runtime.command({ action: 'focus-set', issues: ['EX-1'] });
  await submit(runtime, 2);
  await step(runtime);
  assert.equal(judged.length, 1);
  await runtime.command({ action: 'focus-add', issues: ['EX-9'] });
  await step(runtime);
  assert.equal(judged.length, 2);
  await runtime.command({ action: 'focus-remove', issues: ['EX-9'] });
  const snap = await runtime.snapshot();
  assert.deepEqual(snap.focus.issues, ['EX-1']);
  assert.ok(snap.opsLog.some(e => e.action === 'focus-remove'));
  // Without focus every task is related (the decision function is a no-op).
  await runtime.command({ action: 'focus-clear' });
  assert.equal(focusDecision(snap.tasks[0], await runtime.store.read()).verdict, 'related');
});

test('reference judge script: calls an OpenAI-compatible gateway with key from a named env var, via commandJudge', async () => {
  const http = await import('node:http');
  const { parseReply } = await import('../scripts/focus-judge.mjs');
  const seen = [];
  const server = http.createServer((req, res) => { let body = ''; req.on('data', d => body += d).on('end', () => {
    seen.push({ auth: req.headers.authorization, body: JSON.parse(body) });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: 'thinking...\n```json\n{"verdict":"related","reason":"是 EX-1 的拆单"}\n```' } }] }));
  }); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try {
    const url = `http://127.0.0.1:${server.address().port}/v1/chat/completions`;
    const script = new URL('../scripts/focus-judge.mjs', import.meta.url);
    const settings = { focus: { judge: { command: process.execPath, args: [fileURLToPath(script), '--key-env', 'MY_JUDGE_KEY', '--gateway', url, '--model', 'm-1'], timeoutMs: 10000 } } };
    const verdict = await commandJudge({ focus: { issues: ['EX-1'], intent: '今天只做 EX-1' }, candidate: { identifier: 'EX-2', title: 't' } },
      { settings, env: { ...process.env, MY_JUDGE_KEY: 'k-123' } });
    assert.deepEqual(verdict, { verdict: 'related', reason: '是 EX-1 的拆单' });
    assert.equal(seen[0].auth, 'Bearer k-123');
    assert.equal(seen[0].body.model, 'm-1');
    assert.match(seen[0].body.messages[1].content, /EX-2/);
    await assert.rejects(commandJudge({ focus: {}, candidate: {} }, { settings, env: { ...process.env, MY_JUDGE_KEY: '' } }), /退出码/);
    assert.equal(parseReply('{"verdict":"Unrelated","reason":"x"}').verdict, 'unrelated');
    assert.throws(() => parseReply('no idea'));
  } finally { server.close(); }
});
