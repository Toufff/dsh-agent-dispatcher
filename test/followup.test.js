import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { Runtime } from '../src/runtime.js';
import { initialState } from '../src/config.js';
import { MemoryStore } from '../src/dispatcher.js';
import { parseOutcome } from '../src/outcome.js';
import { wakeEvent } from '../src/followup.js';
import { shareable } from '../src/reporting.js';
import { WaitTargetError } from '../src/linear.js';

const contract = (status, extra = {}) => `<dispatch-result>${JSON.stringify({ status,
  evidence: ['isolated check passed'], remaining: status === 'complete' ? [] : ['peer receipt'],
  next: '', progress: 'verified local work', blockers: status === 'blocked' ? [{ owner: 'peer', reason: 'await receipt', resumeWhen: 'verified receipt' }] : [], ...extra })}</dispatch-result>`;
const comment = (id = 'reply', user = 'peer', when = new Date(Date.now() + 1).toISOString(), body = 'Receipt ready, please verify.') => ({ id, user: { id: user }, updatedAt: when, body });
async function fixture(wait = { kind: 'linear', expectedAuthorIds: ['peer'], condition: 'verified peer receipt', issueId: 'child' }) {
  const store = new MemoryStore(), state = initialState();
  state.paused = false;
  state.settings.projects = [{ id: 'p', label: 'Synthetic', cwd: process.cwd(), executionInstructions: 'No production writes; verify all approvals.',
    followup: { enabled: true, commentAuthorIds: ['peer'], maxWakeups: 3 },
    linear: { enabled: true, tokenEnv: 'TEST_TOKEN', workspaceId: 'w', projectId: 'project', assigneeId: 'owner', activeStateId: 'active', reviewStateId: 'review', blockedStateId: 'blocked', shareProgress: true, round: '1' } }];
  await store.save(state);
  let starts = 0, comments = [], failActivity = false;
  const reports = [];
  const factory = () => ({ issues: async () => [], eligible: async () => ({}), report: async i => reports.push(i), activity: async () => {
    if (failActivity) throw new Error('Temporary read failure');
    return { id: 'child', identifier: 'EX-2', state: { type: 'started' }, comments };
  } });
  const runtime = await new Runtime({ store, directory: os.tmpdir(), env: { TEST_TOKEN: 'synthetic' }, linearFactory: factory }).init();
  const adapter = { health: async () => ({ available: true }), start: async ({ task, attempt }) => {
    starts++; if (starts > 1) { assert.equal(attempt.resume, true); assert.equal(attempt.sessionId, 'registered');
      assert.match(task.prompt, /NOT authorization/); assert.match(task.prompt, /No production writes/); }
    return { status: 'review', sessionId: 'registered', summary: starts === 1 ? contract('blocked', { wait, publicSummary: 'Local checks passed. Peer must supply the migration receipt before release.' }) : contract('complete') };
  } };
  runtime.adapters.codex = adapter;
  await runtime.submit({ projectId: 'p', prompt: 'Synthetic local task', issue: { id: 'parent' } });
  await runtime.dispatcher.tick(); await runtime.assess();
  return { runtime, store, factory, adapter, reports, get starts() { return starts; }, setComments: v => { comments = v; }, fail: v => { failActivity = v; } };
}

test('trusted child reply resumes original session exactly once across concurrent polls and restart', async () => {
  const f = await fixture(); f.setComments([comment()]);
  await Promise.all([f.runtime.monitor(), f.runtime.monitor()]);
  const queued = (await f.runtime.snapshot()).tasks[0];
  assert.equal(queued.status, 'queued'); assert.equal(queued.wakeups, 1);
  const next = await new Runtime({ store: f.store, directory: os.tmpdir(), env: { TEST_TOKEN: 'synthetic' }, linearFactory: f.factory }).init();
  next.adapters.codex = f.adapter;
  await next.monitor(); await next.dispatcher.tick(); await next.assess(); await next.report();
  assert.equal(f.starts, 2); assert.equal((await next.snapshot()).tasks[0].status, 'review');
  assert.equal((await next.snapshot()).tasks[0].rounds.length, 1);
});

test('stored missing-close result recovers its wait after restart, catches an intervening reply and wakes once', async () => {
  const f = await fixture();
  const original = (await f.runtime.snapshot()).tasks[0];
  const raw = original.summary.replace(/<\/dispatch-result>$/, '');
  await f.runtime.dispatcher.update(s => {
    const t = s.tasks[0]; t.summary = raw; t.status = 'needs_result'; t.outcome = null;
    t.formatRepair = true; t.resultError = 'Return exactly one dispatch-result block.';
    delete t.wait; delete t.waitProject;
  });
  // This reply predates recovery, but follows the original completed attempt.
  f.setComments([comment('arrived-during-format-error')]);
  const next = await new Runtime({ store: f.store, directory: os.tmpdir(), env: { TEST_TOKEN: 'synthetic' }, linearFactory: f.factory }).init();
  next.adapters.codex = f.adapter;
  await next.assess(); await next.assess();
  let t = (await next.snapshot()).tasks[0];
  assert.equal(f.starts, 1); assert.equal(t.status, 'blocked'); assert.equal(t.summary, raw);
  assert.equal(t.wait.armedAt, original.attempts[0].startedAt);
  assert.equal(t.events.filter(e => e.action === 'recover-result-framing').length, 1);
  assert.equal(t.resultError, undefined);
  await Promise.all([next.monitor(), next.monitor()]);
  assert.equal((await next.snapshot()).tasks[0].wakeups, 1);
  await next.dispatcher.tick(); await next.assess(); await next.report(); await next.monitor();
  t = (await next.snapshot()).tasks[0];
  assert.equal(f.starts, 2); assert.equal(t.status, 'review'); assert.equal(t.report, 'sent');
  assert.equal(t.rounds[0].summary, raw);
});

test('framing recovery cannot bypass ownership, an uncertain receipt or decision-only result', async () => {
  for (const guard of ['human', 'unknown', 'decision']) {
    const f = await fixture();
    await f.runtime.dispatcher.update(s => {
      const t = s.tasks[0]; t.status = 'needs_result'; t.outcome = null; delete t.wait;
      t.summary = (guard === 'decision' ? contract('decision', {
        blockers: [{ owner: 'owner', reason: 'needs decision', resumeWhen: 'decision made' }]
      }) : t.summary).replace(/<\/dispatch-result>$/, '');
      if (guard === 'human') t.owner = 'human';
      if (guard === 'unknown') t.attempts[0].status = 'unknown';
    });
    f.setComments([comment()]); await f.runtime.assess(); await f.runtime.monitor();
    assert.equal(f.starts, 1);
    assert.equal((await f.runtime.snapshot()).tasks[0].status, guard === 'decision' ? 'decision' : 'needs_result');
  }
});

test('self, unrelated author, old replies and local outbox comments do not wake work', async () => {
  const f = await fixture();
  await f.runtime.dispatcher.update(s => { s.outbox.push({ id: 'own-report', status: 'sent' }); });
  f.setComments([comment('self', 'owner'), comment('outsider', 'stranger'), comment('old', 'peer', '2000-01-01T00:00:00Z'), comment('own-report')]);
  await f.runtime.monitor(); assert.equal((await f.runtime.snapshot()).tasks[0].status, 'blocked'); assert.equal(f.starts, 1);
});

test('paused monitoring consumes nothing; resume sees the same comment', async () => {
  const f = await fixture(); f.setComments([comment()]);
  await f.runtime.command({ action: 'pause' }); await f.runtime.monitor();
  assert.equal((await f.runtime.snapshot()).tasks[0].wakeups, undefined);
  await f.runtime.command({ action: 'resume' }); await f.runtime.monitor();
  assert.equal((await f.runtime.snapshot()).tasks[0].wakeups, 1);
});

test('manual takeover during an outstanding poll prevents queued duplicate work', async () => {
  const f = await fixture(); let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  f.runtime.linearFactory = () => ({ activity: async () => { entered(); return new Promise(resolve => { release = resolve; }); } });
  const monitoring = f.runtime.monitor(); await started;
  const id = (await f.runtime.snapshot()).tasks[0].id;
  await f.runtime.command({ action: 'takeover', id });
  release({ state: { type: 'started' }, comments: [comment()] }); await monitoring;
  assert.equal((await f.runtime.snapshot()).tasks[0].owner, 'human'); assert.equal(f.starts, 1);
});

test('API failure stays blocked and retries without losing the reply', async () => {
  const f = await fixture(); f.setComments([comment()]); f.fail(true); await f.runtime.monitor();
  assert.match((await f.runtime.snapshot()).tasks[0].wait.error, /Temporary/);
  f.fail(false); await f.runtime.monitor(); assert.equal((await f.runtime.snapshot()).tasks[0].status, 'queued');
});

test('invalid target stops retrying durably, reports once and never launches', async () => {
  const f = await fixture(); await f.runtime.report(); const baseline = f.reports.length;
  let reads = 0;
  const factory = () => ({ ...f.factory(), activity: async () => { reads++; throw new WaitTargetError(); } });
  f.runtime.linearFactory = factory;
  const before = (await f.runtime.snapshot()).tasks[0];
  await f.runtime.monitor(); await f.runtime.report();
  const invalid = (await f.runtime.snapshot()).tasks[0];
  assert.equal(invalid.wait.status, 'invalid'); assert.equal(invalid.wait.errorCode, 'INVALID_WAIT_TARGET');
  assert.deepEqual(invalid.attempts, before.attempts); assert.equal(invalid.wait.armedAt, before.wait.armedAt);
  assert.equal(f.reports.length, baseline + 1); assert.match(f.reports.at(-1).body, /停止重试/);
  const next = await new Runtime({ store: f.store, directory: os.tmpdir(), env: { TEST_TOKEN: 'synthetic' }, linearFactory: factory }).init();
  next.adapters.codex = f.adapter;
  await next.monitor(); await next.report(); await next.dispatcher.tick();
  assert.equal(reads, 1); assert.equal(f.starts, 1); assert.equal(f.reports.length, baseline + 1);
  assert.match((await next.snapshot()).errors.join(''), /配置无效/);
});

test('manual wait validation rejects invalid target without replacing evidence and accepts corrected wait without launching', async () => {
  const f = await fixture(), before = (await f.runtime.snapshot()).tasks[0];
  f.runtime.linearFactory = () => ({ activity: async () => { throw new WaitTargetError(); } });
  await assert.rejects(f.runtime.command({ action: 'arm-wait', id: before.id, wait: { kind: 'linear', expectedAuthorIds: ['peer'], issueId: 'unrelated', condition: 'receipt' } }), error => error.code === 'INVALID_WAIT_TARGET');
  assert.deepEqual((await f.runtime.snapshot()).tasks[0], before);
  f.runtime.linearFactory = f.factory;
  await f.runtime.command({ action: 'arm-wait', id: before.id, wait: { kind: 'linear', expectedAuthorIds: ['peer'], issueId: 'parent', condition: 'reply on this issue' } });
  const after = (await f.runtime.snapshot()).tasks[0];
  assert.equal(after.wait.issueId, 'parent'); assert.equal(after.wait.status, 'watching');
  assert.deepEqual(after.waitHistory.at(-1), before.wait); assert.deepEqual(after.attempts, before.attempts); assert.equal(f.starts, 1);
});

test('changing a mapping during target validation cannot overwrite the existing wait', async () => {
  const f = await fixture(), before = (await f.runtime.snapshot()).tasks[0];
  let enter, release; const entered = new Promise(resolve => { enter = resolve; });
  f.runtime.linearFactory = () => ({ activity: async () => { enter(); return new Promise(resolve => { release = resolve; }); } });
  const arming = f.runtime.command({ action: 'arm-wait', id: before.id, wait: { kind: 'linear', expectedAuthorIds: ['peer'], issueId: 'parent', condition: 'receipt' } });
  await entered; await f.runtime.dispatcher.update(s => { s.settings.projects[0].linear.projectId = 'changed'; });
  release({ comments: [] }); await assert.rejects(arming, /changed while checking/);
  assert.deepEqual((await f.runtime.snapshot()).tasks[0].wait, before.wait); assert.equal(f.starts, 1);
});

test('sustained monitor failure is durable, reported once, and recovery never reexecutes work', async () => {
  const f = await fixture(); await f.runtime.report(); const baseline=f.reports.length;
  f.fail(true);
  await f.runtime.monitor(); await f.runtime.report();
  await f.runtime.monitor(); await f.runtime.report();
  assert.equal(f.reports.length,baseline);
  await f.runtime.monitor(); await f.runtime.report();
  assert.equal(f.reports.length,baseline+1);
  assert.match(f.reports.at(-1).body,/监听连续失败/);
  assert.doesNotMatch(f.reports.at(-1).body,/Temporary read failure/);
  const next=await new Runtime({store:f.store,directory:os.tmpdir(),env:{TEST_TOKEN:'synthetic'},linearFactory:f.factory}).init();
  next.adapters.codex=f.adapter;
  await next.monitor();await next.report();
  assert.equal(f.reports.length,baseline+1);
  assert.match((await next.snapshot()).errors.join(''),/4 次/);
  f.fail(false);await next.monitor();await next.report();await next.dispatcher.tick();
  assert.equal(f.reports.length,baseline+2);assert.match(f.reports.at(-1).body,/监听已于/);
  await next.monitor();await next.report();
  assert.equal(f.reports.length,baseline+2);assert.equal(f.starts,1);
  assert.equal((await next.snapshot()).tasks[0].status,'blocked');
  assert.equal((await next.snapshot()).errors.length,0);
});

test('disabled original executor accumulates a visible fault without fallback or losing a reply',async()=>{
  const f=await fixture();f.setComments([comment()]);
  await f.runtime.dispatcher.update(s=>{s.settings.executors.find(e=>e.id==='codex').enabled=false;});
  for(let i=0;i<3;i++)await f.runtime.monitor();
  let t=(await f.runtime.snapshot()).tasks[0];assert.equal(t.wait.errorCount,3);assert.equal(t.wait.failureNotified,true);
  assert.equal(f.starts,1);assert.equal(t.followupSeen,undefined);
  await f.runtime.dispatcher.update(s=>{s.settings.executors.find(e=>e.id==='codex').enabled=true;});
  await f.runtime.monitor();await f.runtime.dispatcher.tick();await f.runtime.assess();
  t=(await f.runtime.snapshot()).tasks[0];assert.equal(f.starts,2);assert.equal(t.status,'review');assert.equal(t.wait.error,undefined);
});

test('time wait survives restart and never wakes before exact offset timestamp', async () => {
  const future = new Date(Date.now() + 60000).toISOString();
  const f = await fixture({ kind: 'time', condition: 'recheck after authorized interval', notBefore: future });
  await f.runtime.monitor(); assert.equal((await f.runtime.snapshot()).tasks[0].status, 'blocked');
  await f.runtime.dispatcher.update(s => { s.tasks[0].wait.notBefore = '2000-01-01T00:00:00+08:00'; });
  const next = await new Runtime({ store: f.store, directory: os.tmpdir(), env: { TEST_TOKEN: 'synthetic' }, linearFactory: f.factory }).init(); next.adapters.codex = f.adapter;
  await next.monitor(); await next.monitor(); assert.equal((await next.snapshot()).tasks[0].wakeups, 1);
});

test('expired window never runs, including expiration while queued behind another task', async () => {
  const f = await fixture({ kind: 'time', condition: 'window', notBefore: '2000-01-01T00:00:00Z', expiresAt: '2000-01-01T00:01:00Z' });
  await f.runtime.monitor(); assert.equal((await f.runtime.snapshot()).tasks[0].wait.status, 'expired');
  await f.runtime.dispatcher.update(s => { const t = s.tasks[0]; t.wait.status = 'watching'; t.wait.expiresAt = new Date(Date.now() + 60000).toISOString(); });
  await f.runtime.monitor();
  await f.runtime.dispatcher.update(s => { s.tasks[0].resumeWindow.expiresAt = '2000-01-01T00:01:00Z'; });
  await f.runtime.dispatcher.tick(); assert.equal(f.starts, 1); assert.equal((await f.runtime.snapshot()).tasks[0].wait.status, 'expired');
});

test('wake ceiling and disabled executor prevent a notification-driven loop', async () => {
  const f = await fixture(); f.setComments([comment()]);
  await f.runtime.dispatcher.update(s => { s.tasks[0].wakeups = 3; });
  await f.runtime.monitor(); assert.equal((await f.runtime.snapshot()).tasks[0].wait.status, 'limit');
  await f.runtime.dispatcher.update(s => { s.tasks[0].wakeups = 0; s.tasks[0].wait.status = 'watching'; s.settings.executors[0].enabled = false; });
  await f.runtime.monitor(); assert.equal((await f.runtime.snapshot()).tasks[0].status, 'blocked');
});

test('expired queued continuation preserves evidence and can explicitly rearm the same session', async () => {
  const f = await fixture();
  const summary = contract('continue', { next: 'Continue isolated validation', remaining: ['isolated validation'], progress: 'new local evidence' });
  await f.runtime.dispatcher.update(s => {
    const t = s.tasks[0]; t.status = 'review'; t.assessed = false; t.summary = summary;
    t.resumeWindow = { expiresAt: '2000-01-01T00:01:00Z' };
  });
  await f.runtime.assess(); await f.runtime.dispatcher.tick();
  let t = (await f.runtime.snapshot()).tasks[0];
  assert.equal(t.status, 'blocked'); assert.equal(t.attempts.length, 0);
  assert.equal(t.summary, summary); assert.equal(f.starts, 1);
  const oldWait = structuredClone(t.wait);
  await f.runtime.command({ action: 'arm-wait', id: t.id, wait: {
    kind: 'time', condition: 'New local validation interval; production remains forbidden',
    notBefore: new Date(Date.now()-1000).toISOString(), expiresAt: new Date(Date.now()+60000).toISOString()
  } });
  const next = await new Runtime({ store: f.store, directory: os.tmpdir(), env: { TEST_TOKEN: 'synthetic' }, linearFactory: f.factory }).init();
  next.adapters.codex = f.adapter;
  await next.monitor(); await next.dispatcher.tick();
  t = (await next.snapshot()).tasks[0];
  assert.equal(f.starts, 2); assert.equal(t.attempts[0].sessionId, 'registered');
  assert.ok(t.waitHistory.some(w => w.id === oldWait.id));
  assert.ok(t.prompt.includes(summary));
});

test('missing current attempts never allow rearming or continuing an unrelated historical session', async () => {
  const f = await fixture();
  await f.runtime.dispatcher.update(s => {
    const t=s.tasks[0]; t.previousAttempts=t.attempts; t.attempts=[];
    t.session={executor:'codex',id:'different-session'};
  });
  const t=(await f.runtime.snapshot()).tasks[0];
  await assert.rejects(f.runtime.command({action:'arm-wait',id:t.id,wait:{kind:'linear', expectedAuthorIds: ['peer'],condition:'recheck',issueId:'child'}}), /confirmed finished/);
  await assert.rejects(f.runtime.command({action:'continue',id:t.id}), /unconfirmed/);
  assert.equal(f.starts,1);
});

test('local mapping change and closed parent fail closed; completed child can wake parent', async () => {
  const f = await fixture(); f.setComments([comment()]);
  await f.runtime.dispatcher.update(s => { s.settings.projects[0].cwd = os.tmpdir(); });
  await f.runtime.monitor(); assert.equal((await f.runtime.snapshot()).tasks[0].wait.errorCode, 'WAIT_CONFIGURATION_CHANGED');
  const wait = { id: 'w', kind: 'linear', expectedAuthorIds: ['peer'], armedAt: '2000-01-01T00:00:00Z' };
  assert.equal(wakeEvent(wait, { parentState: { type: 'completed' }, comments: [comment()] }, { commentAuthorIds: ['peer'] }, Date.now()), null);
  assert.ok(wakeEvent(wait, { state: { type: 'completed' }, comments: [comment()] }, { commentAuthorIds: ['peer'] }, Date.now()));
});

test('intake failures in one project do not starve other projects or condition monitoring', async () => {
  const f = await fixture(); f.setComments([comment()]);
  const original = f.runtime.linearFactory;
  f.runtime.linearFactory = () => ({ ...original(), changes: async () => ({ issues: [], until: new Date().toISOString(),
    watched: [{ id: 'parent', project: { id: 'project' }, assignee: { id: 'owner' }, state: { type: 'started' } }, { id: 'child', parent: { id: 'parent' }, project: { id: 'project' } }],
    comments: [{ ...comment(), issue: { id: 'child' } }] }) });
  await f.runtime.dispatcher.update(s => { s.settings.projects.unshift({ id: 'bad', label: 'Bad', cwd: os.tmpdir(), linear: { enabled: true, tokenEnv: 'MISSING' } }); });
  f.runtime.adapters = { codex: f.adapter }; f.runtime.dispatcher.adapters = f.runtime.adapters;
  await f.runtime.cycle(); assert.equal(f.starts, 2);
  assert.ok((await f.runtime.snapshot()).syncStatus.some(s => s.error));
});

test('reporting includes opted-in blockers, retries independently, supersedes stale status and reports acceptance', async () => {
  const f = await fixture(); let offline = true;
  const original = f.runtime.linearFactory;
  f.runtime.linearFactory = () => ({ ...original(), report: async item => { if (offline) throw new Error('offline'); f.reports.push(item); } });
  await f.runtime.report(); assert.match((await f.runtime.snapshot()).outbox[0].body, /Peer must supply/);
  f.setComments([comment()]); await f.runtime.monitor(); await f.runtime.dispatcher.tick(); await f.runtime.assess();
  offline = false; await f.runtime.dispatcher.update(s => { s.outbox[0].nextAt = 0; }); await f.runtime.report();
  assert.equal((await f.runtime.snapshot()).outbox[0].status, 'superseded'); assert.equal(f.reports.length, 1);
  const task = (await f.runtime.snapshot()).tasks[0]; await f.runtime.command({ action: 'accept', id: task.id }); await f.runtime.report();
  assert.match(f.reports.at(-1).body, /本地确认验收|本地确认|本地.*验收/); assert.equal(f.starts, 2);
});

test('shareable summary rejects credentials and local paths; malformed time is not accepted', () => {
  for (const text of ['C:/private/a', '/home/me/a', 'token=abc', 'lin_api_example', 'Bearer example', 'my secret-value'])
    assert.equal(shareable(text, ['secret-value']), false);
  assert.equal(parseOutcome(contract('blocked', { wait: { kind: 'time', condition: 'later', notBefore: '15:20' } })), null);
  assert.equal(parseOutcome(contract('complete', { wait: { kind: 'linear', expectedAuthorIds: ['peer'], condition: 'reply' } })), null);
});

test('manual continuation supersedes monitoring even if cancellation write was interrupted', async () => {
  const f = await fixture(); const task = (await f.runtime.snapshot()).tasks[0]; f.setComments([comment()]);
  await f.runtime.command({ action: 'continue', id: task.id });
  await f.runtime.dispatcher.update(s => { s.tasks[0].wait.status = 'watching'; });
  await f.runtime.monitor(); assert.equal((await f.runtime.snapshot()).tasks[0].wakeups, undefined);
});

test('explicit wait setup preserves the finished session and ignores historical replies', async () => {
  const f = await fixture(); const task = (await f.runtime.snapshot()).tasks[0];
  await f.runtime.command({action:'arm-wait',id:task.id,wait:{kind:'linear', expectedAuthorIds: ['peer'],condition:'New peer receipt',issueId:'child'}});
  assert.equal((await f.runtime.snapshot()).tasks[0].attempts.at(-1).sessionId,'registered');
  f.setComments([comment('historical','peer','2000-01-01T00:00:00Z')]);
  await f.runtime.monitor(); assert.equal(f.starts,1); assert.equal((await f.runtime.snapshot()).tasks[0].status,'blocked');
  await f.runtime.command({action:'takeover',id:task.id});
  await assert.rejects(f.runtime.command({action:'arm-wait',id:task.id,wait:{kind:'linear', expectedAuthorIds: ['peer'],condition:'test'}}),/scheduler-owned/);
});

test('another blocked round does not replay a consumed comment, but an edit can wake it', async () => {
  const f=await fixture(); const reply=comment(); f.setComments([reply]);
  await f.runtime.monitor(); await f.runtime.dispatcher.tick();
  await f.runtime.dispatcher.update(s=>{s.tasks[0].summary=contract('blocked',{wait:{kind:'linear', expectedAuthorIds: ['peer'],condition:'Need fuller receipt',issueId:'child'}});});
  await f.runtime.assess(); await f.runtime.monitor();
  assert.equal((await f.runtime.snapshot()).tasks[0].wakeups,1);
  f.setComments([{...reply,updatedAt:new Date(Date.now()+1000).toISOString(),body:'Additional receipt'}]);
  await f.runtime.monitor(); assert.equal((await f.runtime.snapshot()).tasks[0].wakeups,2);
});

test('missing original session cannot silently become a new session',async()=>{
 const f=await fixture(); f.setComments([comment()]);
 await f.runtime.dispatcher.update(s=>{delete s.tasks[0].attempts[0].sessionId;});
 await f.runtime.monitor(); assert.equal((await f.runtime.snapshot()).tasks[0].status,'blocked');
 assert.match((await f.runtime.snapshot()).tasks[0].wait.error,/session unavailable/);
});

test('disk restart preserves triggered cursor and never executes an unpersisted wake',async()=>{
 const {FileStore}=await import('../src/store.js'); const {mkdtemp,rm}=await import('node:fs/promises');
 const path=await import('node:path'); const dir=await mkdtemp(path.join(os.tmpdir(),'dispatch-followup-'));
 const f=await fixture(); const reply=comment(); f.setComments([reply]);
 const disk=await new FileStore(dir).open();
 try {
  await disk.save(await f.store.load()); await disk.close();
  const reopened=await new FileStore(dir).open();
  const r=await new Runtime({store:reopened,directory:dir,env:{TEST_TOKEN:'synthetic'},linearFactory:f.factory}).init();r.adapters.codex=f.adapter;
  const original=reopened.save.bind(reopened); let fail=true;
  reopened.save=async state=>{if(fail&&state.tasks[0].status==='queued')throw new Error('disk unavailable');return original(state);};
  await r.monitor(); await r.dispatcher.tick(); assert.equal(f.starts,1);
  fail=false; await r.monitor(); await reopened.close();
  const final=await new FileStore(dir).open();
  const r2=await new Runtime({store:final,directory:dir,env:{TEST_TOKEN:'synthetic'},linearFactory:f.factory}).init();r2.adapters.codex=f.adapter;
  await r2.monitor(); await r2.dispatcher.tick(); await r2.assess();assert.equal(f.starts,2); assert.equal((await r2.snapshot()).tasks[0].wakeups,1); await final.close();
 }finally{await disk.close();await rm(dir,{recursive:true,force:true});}
});

test('queued issue is rechecked before execution and a reassigned issue does not start',async()=>{
 const f=await fixture(); f.setComments([comment()]); await f.runtime.monitor();
 const original=f.runtime.linearFactory; f.runtime.linearFactory=()=>({...original(),eligible:async()=>{throw new Error('reassigned');}});
 await f.runtime.dispatcher.tick();assert.equal(f.starts,1);assert.match((await f.runtime.snapshot()).tasks[0].admissionError,/复核未通过/);
});

test('reassessment recovers a stored result without executing and preserves reply cursor across restart', async () => {
  const f = await fixture();
  const id = (await f.runtime.snapshot()).tasks[0].id;
  await f.runtime.dispatcher.update(s => {
    const t = s.tasks[0]; t.status = 'needs_result'; t.outcome = null; t.formatRepair = true;
    t.wait.status = 'resolved'; t.attempts[0].startedAt = '2030-01-01T10:00:00Z';
    t.summary = contract('blocked', { next: 'Verify the receipt before any change',
      wait: { kind: 'linear', expectedAuthorIds: ['peer'], issueId: 'child', condition: 'Receipt', expiresAt: '2030-01-01T21:30:00+08:00' } });
  });
  const before = (await f.runtime.snapshot()).tasks[0];
  await f.runtime.command({ action: 'reassess-result', id });
  const recovered = (await f.runtime.snapshot()).tasks[0];
  assert.equal(f.starts, 1); assert.equal(recovered.status, 'blocked'); assert.equal(recovered.wait.status, 'validating');
  assert.equal(recovered.wait.armedAt, before.attempts[0].startedAt);
  assert.equal(recovered.wait.expiresAt, '2030-01-01T21:30:00+08:00');
  assert.deepEqual(recovered.attempts, before.attempts); assert.equal(recovered.summary, before.summary);
  await assert.rejects(f.runtime.command({ action: 'reassess-result', id }), /unclassified/);
  const next = await new Runtime({ store: f.store, directory: os.tmpdir(), env: { TEST_TOKEN: 'synthetic' }, linearFactory: f.factory }).init();
  next.adapters.codex = f.adapter;
  f.setComments([comment('receipt', 'peer', '2030-01-01T10:01:00Z')]);
  await next.monitor(); await next.monitor();
  assert.equal((await next.snapshot()).tasks[0].wakeups, 1);
  await next.dispatcher.tick(); assert.equal(f.starts, 2);
});

test('reassessment rejects execution outcomes, human ownership and superseded results', async () => {
  const f = await fixture(); const id = (await f.runtime.snapshot()).tasks[0].id;
  await f.runtime.dispatcher.update(s => {
    const t = s.tasks[0]; t.status = 'needs_result';
    t.summary = contract('continue', { next: 'Run more tools' });
  });
  await assert.rejects(f.runtime.command({ action: 'reassess-result', id }), /non-executing/);
  await f.runtime.dispatcher.update(s => { s.tasks[0].owner = 'human'; });
  await assert.rejects(f.runtime.command({ action: 'reassess-result', id }), /scheduler-owned/);
  await f.runtime.dispatcher.update(s => { s.tasks[0].owner = 'scheduler'; s.tasks[0].summary = contract('blocked'); });
  await f.runtime.command({ action: 'continue', id });
  await assert.rejects(f.runtime.command({ action: 'reassess-result', id }), /superseded/);
  assert.equal(f.starts, 1);
});

test('each external wake gets one formatting repair, not a lifetime budget or an infinite loop', async () => {
  const f = await fixture();
  await f.runtime.dispatcher.update(s => { s.tasks[0].formatRepair = true; });
  f.setComments([comment()]); await f.runtime.monitor();
  assert.equal((await f.runtime.snapshot()).tasks[0].formatRepair, false);
  await f.runtime.dispatcher.tick();
  await f.runtime.dispatcher.update(s => { s.tasks[0].summary = 'bad result'; });
  await f.runtime.assess();
  assert.equal((await f.runtime.snapshot()).tasks[0].status, 'queued');
  assert.match((await f.runtime.snapshot()).tasks[0].prompt, /do not execute tools/);
  // Use a separate fake formatting-only adapter to validate its bounded retry.
  f.runtime.adapters.codex = { start: async () => ({ status: 'review', sessionId: 'registered', summary: 'still bad' }) };
  await f.runtime.dispatcher.tick(); await f.runtime.assess();
  assert.equal((await f.runtime.snapshot()).tasks[0].status, 'needs_result');
  await f.runtime.assess(); assert.equal((await f.runtime.snapshot()).tasks[0].status, 'needs_result');
});

test('expiry-only reply monitoring expires without executing a waiting next step', async () => {
  const f = await fixture({ kind: 'linear', expectedAuthorIds: ['peer'], condition: 'receipt before deadline', expiresAt: '2000-01-01T00:00:00Z' });
  f.setComments([comment()]); await f.runtime.monitor(); await f.runtime.dispatcher.tick();
  assert.equal((await f.runtime.snapshot()).tasks[0].wait.status, 'expired'); assert.equal(f.starts, 1);
});

test('expired waits keep opt-in reply observation across restart, never execute or consume the future resume cursor', async () => {
 const f=await fixture({kind:'linear', expectedAuthorIds: ['peer'],condition:'Receipt',issueId:'child',expiresAt:'2000-01-01T00:00:00Z'});
 await f.runtime.dispatcher.update(s=>{s.settings.projects[0].followup.observeAfterExpiry=true;s.tasks[0].waitProject=structuredClone(s.settings.projects[0]);});
 f.fail(true);await f.runtime.monitor();let t=(await f.runtime.snapshot()).tasks[0];assert.equal(t.wait.status,'expired');assert.ok(t.wait.error);
 f.fail(false);const reply=comment();f.setComments([reply]);await f.runtime.monitor();await f.runtime.report();
 t=(await f.runtime.snapshot()).tasks[0];assert.ok(t.wait.pendingUpdate);assert.equal(t.wait.error,undefined);assert.equal(t.followupSeen,undefined);
 const next=await new Runtime({store:f.store,directory:os.tmpdir(),env:{TEST_TOKEN:'synthetic'},linearFactory:f.factory}).init();next.adapters.codex=f.adapter;
 await next.monitor();await next.report();await next.dispatcher.tick();
 assert.equal(f.starts,1);assert.equal(f.reports.length,1);assert.match(f.reports[0].body,/窗口过期后已收到/);
 assert.equal((await next.snapshot()).tasks[0].wait.expiresAt,'2000-01-01T00:00:00Z');
});

test('deadline is enforced locally even if a time-wait eligibility service is unavailable', async () => {
 const f=await fixture({kind:'time',condition:'Deadline',notBefore:'2000-01-01T00:00:00Z',expiresAt:'2000-01-01T01:00:00Z'});
 let calls=0;f.runtime.linearFactory=()=>({eligible:async()=>{calls++;throw new Error('offline');}});
 await f.runtime.monitor();assert.equal((await f.runtime.snapshot()).tasks[0].wait.status,'expired');assert.equal(calls,0);assert.equal(f.starts,1);
});

test('explicit cursor-preserving rearm does not lose replies received during maintenance', async()=>{
 const f=await fixture();const before=(await f.runtime.snapshot()).tasks[0];
 f.setComments([comment('maintenance-reply','peer',new Date(Date.parse(before.wait.armedAt)+1).toISOString())]);
 await f.runtime.command({action:'arm-wait',id:before.id,preserveCursor:true,wait:{kind:'linear', expectedAuthorIds: ['peer'],condition:'Verify receipt',issueId:'child'}});
 assert.equal((await f.runtime.snapshot()).tasks[0].wait.armedAt,before.wait.armedAt);
 assert.equal((await f.runtime.snapshot()).tasks[0].waitHistory.length,1);
 await f.runtime.monitor();assert.equal((await f.runtime.snapshot()).tasks[0].wakeups,1);
});

async function dependencyFixture() {
  const f = await fixture();
  const dependent = (await f.runtime.snapshot()).tasks[0];
  const target = structuredClone(dependent);
  Object.assign(target, { id: 'dependency', key: JSON.stringify(['local-dependency', '1']), issue: { id: 'dependency-issue', identifier: 'EX-99' }, status: 'running', wait: undefined, outcome: null });
  target.attempts = [{ id: 'target-attempt', status: 'running', accepted: true, executor: 'codex', sessionId: 'target-session' }];
  await f.runtime.dispatcher.update(s => { s.tasks.push(target); });
  await f.runtime.command({ action: 'arm-wait', id: dependent.id, wait: { kind: 'task', issueId: 'EX-99', condition: 'verify local task result' } });
  const complete = async () => f.runtime.dispatcher.update(s => {
    const t = s.tasks.find(t => t.id === target.id); t.status = 'review'; t.assessed = true;
    t.outcome = parseOutcome(contract('complete')); t.attempts[0].status = 'review';
  });
  return { ...f, dependentId: dependent.id, complete, targetId: target.id };
}

test('local dependency resumes original session exactly once without any author comment, across pause/restart and concurrent polls', async () => {
  const f = await dependencyFixture();
  await f.runtime.monitor({localOnly:true});
  assert.equal((await f.runtime.snapshot()).tasks[0].status, 'blocked');
  await f.runtime.command({action:'pause'}); await f.complete(); await f.runtime.monitor();
  assert.equal((await f.runtime.snapshot()).tasks[0].status, 'blocked');
  const next = await new Runtime({store:f.store,directory:os.tmpdir(),env:{TEST_TOKEN:'synthetic'},linearFactory:f.factory}).init(); next.adapters.codex=f.adapter;
  await next.command({action:'resume'});
  await Promise.all([next.monitor({localOnly:true}),next.monitor({localOnly:true})]);
  let t=(await next.snapshot()).tasks[0]; assert.equal(t.wakeups,1); assert.equal(t.status,'queued'); assert.equal(t.session.id,'registered');
  await next.dispatcher.tick(); await next.assess();
  t=(await next.snapshot()).tasks[0]; assert.equal(t.status,'review'); assert.equal(t.previousAttempts.length,1);
  assert.equal(t.attempts[0].sessionId,'registered'); assert.equal(t.rounds.length,1);
});

test('task references reject self, unknown, cross-project, ambiguous and cyclic dependencies without replacing evidence', async()=>{
  const f=await dependencyFixture(), before=(await f.runtime.snapshot()).tasks[0];
  for(const taskId of [before.id,'missing']) await assert.rejects(f.runtime.command({action:'arm-wait',id:before.id,wait:{kind:'task',taskId,condition:'verify'}}), e=>e.code==='WAIT_DEPENDENCY_INVALID');
  await f.runtime.dispatcher.update(s=>{s.tasks[1].projectId='other';});
  await assert.rejects(f.runtime.command({action:'arm-wait',id:before.id,wait:{kind:'task',taskId:f.targetId,condition:'verify'}}), e=>e.code==='WAIT_DEPENDENCY_INVALID');
  await f.runtime.dispatcher.update(s=>{s.tasks[1].projectId='p';s.tasks.push({...structuredClone(s.tasks[1]),id:'duplicate'});});
  await assert.rejects(f.runtime.command({action:'arm-wait',id:before.id,wait:{kind:'task',issueId:'EX-99',condition:'verify'}}), e=>e.code==='WAIT_DEPENDENCY_INVALID');
  await f.runtime.dispatcher.update(s=>{s.tasks.pop(); s.tasks[1].status='blocked';s.tasks[1].wait={kind:'task',taskId:before.id};});
  await assert.rejects(f.runtime.command({action:'arm-wait',id:before.id,wait:{kind:'task',taskId:f.targetId,condition:'verify'}}), e=>e.code==='WAIT_DEPENDENCY_CYCLE');
  assert.deepEqual((await f.runtime.snapshot()).tasks[0].wait,before.wait);
});

test('agent-proposed impossible own-author wait is a persistent actionable fault, not a peer/network wait',async()=>{
  const f=await fixture({kind:'linear',condition:'own task report',expectedAuthorIds:['owner']});
  let t=(await f.runtime.snapshot()).tasks[0]; assert.equal(t.wait.status,'invalid'); assert.equal(t.wait.errorCode,'WAIT_REPLY_UNREACHABLE');
  await f.runtime.report(); const n=f.reports.length;
  const next=await new Runtime({store:f.store,directory:os.tmpdir(),env:{TEST_TOKEN:'synthetic'},linearFactory:f.factory}).init();next.adapters.codex=f.adapter;
  await next.monitor();await next.report();assert.equal(f.reports.length,n);
  assert.match(f.reports.at(-1).body,/本方任务/);assert.equal(f.starts,1);
  await assert.rejects(next.command({action:'arm-wait',id:t.id,wait:{kind:'linear',condition:'bad author',expectedAuthorIds:['outsider']}}),e=>e.code==='WAIT_REPLY_UNREACHABLE');
});

test('failed dependency and changed receipt cannot become completion or trigger another executor',async()=>{
  const f=await dependencyFixture();
  await f.runtime.dispatcher.update(s=>{s.tasks[1].status='failed';});
  await f.runtime.monitor({localOnly:true});let t=(await f.runtime.snapshot()).tasks[0];
  assert.equal(t.wait.status,'invalid');assert.equal(t.wait.errorCode,'WAIT_DEPENDENCY_STOPPED');
  await f.complete(); await f.runtime.command({action:'arm-wait',id:t.id,wait:{kind:'task',taskId:f.targetId,condition:'verified recovery'}});
  await f.runtime.monitor({localOnly:true});assert.equal((await f.runtime.snapshot()).tasks[0].status,'queued');
  await f.runtime.dispatcher.update(s=>{s.tasks[1].outcome=null;});
  await f.runtime.dispatcher.tick(); t=(await f.runtime.snapshot()).tasks[0];
  assert.equal(t.status,'blocked');assert.equal(t.wait.errorCode,'WAIT_DEPENDENCY_PENDING');assert.equal(t.attempts.length,0);
});

test('dependency changes during an API read and the atomic wake is rejected',async()=>{
  const f=await dependencyFixture(); await f.complete();
  let enter,release;const entered=new Promise(r=>enter=r);
  f.runtime.linearFactory=()=>({...f.factory(),eligible:async()=>{enter();await new Promise(r=>release=r);}});
  const monitoring=f.runtime.monitor({localOnly:true});await entered;
  await f.runtime.dispatcher.update(s=>{s.tasks[1].status='failed';});release();await monitoring;
  const t=(await f.runtime.snapshot()).tasks[0];assert.equal(t.status,'blocked');assert.equal(t.wait.errorCode,'WAIT_DEPENDENCY_STOPPED');
});

test('changed local instructions fault immediately even before timer; expiry is globally visible without extending permission',async()=>{
  const f=await fixture({kind:'time',condition:'future',notBefore:new Date(Date.now()+60000).toISOString()});
  await f.runtime.report();const baseline=f.reports.length;
  await f.runtime.dispatcher.update(s=>{s.settings.projects[0].executionInstructions='Different local constraints';});
  await f.runtime.monitor({localOnly:true});await f.runtime.report();await f.runtime.monitor();await f.runtime.report();
  assert.equal(f.reports.length,baseline+1);assert.equal((await f.runtime.snapshot()).tasks[0].wait.errorCode,'WAIT_CONFIGURATION_CHANGED');
  assert.match(f.reports.at(-1).body,/本地执行约束/);
  const expired=await fixture({kind:'time',condition:'expired',notBefore:'2000-01-01T00:00:00Z',expiresAt:'2000-01-01T00:01:00Z'});
  await expired.runtime.monitor({localOnly:true});assert.match((await expired.runtime.snapshot()).errors.join(''),/需要本地负责人/);assert.equal(expired.starts,1);
});

test('requested reply authors are a subset filter and never widen the trusted policy',()=>{
  const wait={kind:'linear',id:'w',armedAt:'2000-01-01T00:00:00Z',expectedAuthorIds:['peer-2']};
  const policy={assigneeId:'owner',commentAuthorIds:['peer','peer-2']};
  assert.equal(wakeEvent(wait,{comments:[comment('other','peer')]},policy,Date.now()),null);
  assert.ok(wakeEvent(wait,{comments:[comment('right','peer-2')]},policy,Date.now()));
});

test('dependency wake survives disk failure/reopen and reporting failure without executing twice',async()=>{
  const {FileStore}=await import('../src/store.js');const {mkdtemp,rm}=await import('node:fs/promises');const path=await import('node:path');
  const dir=await mkdtemp(path.join(os.tmpdir(),'dispatch-dependency-'));
  const f=await dependencyFixture();await f.complete();const disk=await new FileStore(dir).open();let final;
  try {
    await disk.save(await f.store.load());
    const r=await new Runtime({store:disk,directory:dir,env:{TEST_TOKEN:'synthetic'},linearFactory:f.factory}).init();r.adapters.codex=f.adapter;
    const save=disk.save.bind(disk);let fail=true;
    disk.save=async state=>{if(fail&&state.tasks[0].status==='queued')throw new Error('disk offline');return save(state);};
    await r.monitor({localOnly:true});assert.equal((await r.snapshot()).tasks[0].status,'blocked');
    fail=false;await r.monitor({localOnly:true});await disk.close();final=await new FileStore(dir).open();
    const r2=await new Runtime({store:final,directory:dir,env:{TEST_TOKEN:'synthetic'},linearFactory:f.factory}).init();r2.adapters.codex=f.adapter;
    await r2.monitor();await r2.dispatcher.tick();await r2.assess();
    r2.linearFactory=()=>({...f.factory(),report:async()=>{throw new Error('write offline');}});
    await r2.report();await r2.monitor();await r2.dispatcher.tick();
    const t=(await r2.snapshot()).tasks[0];assert.equal(t.status,'review');assert.equal(t.wakeups,1);assert.equal(t.previousAttempts.length,1);assert.equal(t.attempts.length,1);
  }finally{await disk.close();await final?.close();await rm(dir,{recursive:true,force:true});}
});

test('agent-proposed task wait resolves an existing issue, and a three-task cycle faults durably',async()=>{
  const f=await dependencyFixture();
  await f.runtime.dispatcher.update(s=>{
    const t=s.tasks[0];t.status='review';t.assessed=false;t.summary=contract('blocked',{wait:{kind:'task',issueId:'EX-99',condition:'local completion'}});
  });await f.runtime.assess();
  assert.equal((await f.runtime.snapshot()).tasks[0].wait.taskId,f.targetId);
  await f.runtime.dispatcher.update(s=>{
    const third={...structuredClone(s.tasks[1]),id:'third',key:JSON.stringify(['third','1']),status:'blocked',wait:{kind:'task',taskId:s.tasks[0].id,status:'watching'}};
    s.tasks[1].status='blocked';s.tasks[1].wait={kind:'task',taskId:'third',status:'watching'};s.tasks.push(third);
  });await f.runtime.monitor({localOnly:true});
  assert.equal((await f.runtime.snapshot()).tasks[0].wait.errorCode,'WAIT_DEPENDENCY_CYCLE');
});

test('pending local dependencies never poll Linear; an expired task wait never becomes a peer subscription',async()=>{
 const f=await dependencyFixture();let calls=0;
 f.runtime.linearFactory=()=>{calls++;throw new Error('No network expected');};
 await f.runtime.monitor({localOnly:true});assert.equal(calls,0);
 await f.runtime.dispatcher.update(s=>{s.settings.projects[0].followup.observeAfterExpiry=true;s.tasks[0].waitProject=structuredClone(s.settings.projects[0]);s.tasks[0].wait.expiresAt='2000-01-01T00:00:00Z';});
 await f.runtime.monitor();assert.equal(calls,0);assert.equal((await f.runtime.snapshot()).tasks[0].wait.status,'expired');
});

test('legacy undeclared producer becomes a once-reported local fault without replay or cursor loss',async()=>{
 const f=await fixture();await f.runtime.dispatcher.update(s=>{delete s.tasks[0].wait.expectedAuthorIds;});
 const before=(await f.runtime.snapshot()).tasks[0];await f.runtime.monitor({localOnly:true});await f.runtime.report();const n=f.reports.length;
 await f.runtime.monitor();await f.runtime.report();const t=(await f.runtime.snapshot()).tasks[0];
 assert.equal(t.wait.errorCode,'WAIT_REPLY_UNDECLARED');assert.equal(t.wait.armedAt,before.wait.armedAt);assert.deepEqual(t.attempts,before.attempts);assert.equal(f.reports.length,n);
});

test('disabled historical mappings are not validated or advertised as active monitor failures',async()=>{
 const f=await fixture();await f.runtime.dispatcher.update(s=>{s.settings.projects[0].followup.enabled=false;delete s.tasks[0].wait.expectedAuthorIds;});
 const before=(await f.runtime.snapshot()).tasks[0];await f.runtime.monitor({localOnly:true});
 assert.deepEqual((await f.runtime.snapshot()).tasks[0],before);
 await f.runtime.dispatcher.update(s=>{Object.assign(s.tasks[0].wait,{status:'invalid',failureNotified:true,error:'historical fault'});});
 assert.equal((await f.runtime.snapshot()).errors.some(e=>e.includes('historical fault')),false);
});
