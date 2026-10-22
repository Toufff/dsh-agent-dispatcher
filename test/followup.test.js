import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { Runtime } from '../src/runtime.js';
import { initialState } from '../src/config.js';
import { MemoryStore } from '../src/dispatcher.js';
import { parseOutcome } from '../src/outcome.js';
import { wakeEvent } from '../src/followup.js';
import { shareable } from '../src/reporting.js';

const contract = (status, extra = {}) => `<dispatch-result>${JSON.stringify({ status,
  evidence: ['isolated check passed'], remaining: status === 'complete' ? [] : ['peer receipt'],
  next: '', progress: 'verified local work', blockers: status === 'blocked' ? [{ owner: 'peer', reason: 'await receipt', resumeWhen: 'verified receipt' }] : [], ...extra })}</dispatch-result>`;
const comment = (id = 'reply', user = 'peer', when = new Date(Date.now() + 1).toISOString(), body = 'Receipt ready, please verify.') => ({ id, user: { id: user }, updatedAt: when, body });
async function fixture(wait = { kind: 'linear', condition: 'verified peer receipt', issueId: 'child' }) {
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

test('local mapping change and closed parent fail closed; completed child can wake parent', async () => {
  const f = await fixture(); f.setComments([comment()]);
  await f.runtime.dispatcher.update(s => { s.settings.projects[0].cwd = os.tmpdir(); });
  await f.runtime.monitor(); assert.match((await f.runtime.snapshot()).tasks[0].wait.error, /configuration changed/);
  const wait = { id: 'w', kind: 'linear', armedAt: '2000-01-01T00:00:00Z' };
  assert.equal(wakeEvent(wait, { parentState: { type: 'completed' }, comments: [comment()] }, { commentAuthorIds: ['peer'] }, Date.now()), null);
  assert.ok(wakeEvent(wait, { state: { type: 'completed' }, comments: [comment()] }, { commentAuthorIds: ['peer'] }, Date.now()));
});

test('intake failures in one project do not starve other projects or condition monitoring', async () => {
  const f = await fixture(); f.setComments([comment()]);
  await f.runtime.dispatcher.update(s => { s.settings.projects.unshift({ id: 'bad', label: 'Bad', cwd: os.tmpdir(), linear: { enabled: true, tokenEnv: 'MISSING' } }); });
  f.runtime.adapters = { codex: f.adapter }; f.runtime.dispatcher.adapters = f.runtime.adapters;
  await f.runtime.cycle(); assert.equal(f.starts, 2);
  assert.ok(f.runtime.errors.some(e => /intake/.test(e)));
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
  assert.equal(parseOutcome(contract('complete', { wait: { kind: 'linear', condition: 'reply' } })), null);
});

test('manual continuation supersedes monitoring even if cancellation write was interrupted', async () => {
  const f = await fixture(); const task = (await f.runtime.snapshot()).tasks[0]; f.setComments([comment()]);
  await f.runtime.command({ action: 'continue', id: task.id });
  await f.runtime.dispatcher.update(s => { s.tasks[0].wait.status = 'watching'; });
  await f.runtime.monitor(); assert.equal((await f.runtime.snapshot()).tasks[0].wakeups, undefined);
});

test('explicit wait setup preserves the finished session and ignores historical replies', async () => {
  const f = await fixture(); const task = (await f.runtime.snapshot()).tasks[0];
  await f.runtime.command({action:'arm-wait',id:task.id,wait:{kind:'linear',condition:'New peer receipt',issueId:'child'}});
  assert.equal((await f.runtime.snapshot()).tasks[0].attempts.at(-1).sessionId,'registered');
  f.setComments([comment('historical','peer','2000-01-01T00:00:00Z')]);
  await f.runtime.monitor(); assert.equal(f.starts,1); assert.equal((await f.runtime.snapshot()).tasks[0].status,'blocked');
  await f.runtime.command({action:'takeover',id:task.id});
  await assert.rejects(f.runtime.command({action:'arm-wait',id:task.id,wait:{kind:'linear',condition:'test'}}),/scheduler-owned/);
});

test('another blocked round does not replay a consumed comment, but an edit can wake it', async () => {
  const f=await fixture(); const reply=comment(); f.setComments([reply]);
  await f.runtime.monitor(); await f.runtime.dispatcher.tick();
  await f.runtime.dispatcher.update(s=>{s.tasks[0].summary=contract('blocked',{wait:{kind:'linear',condition:'Need fuller receipt',issueId:'child'}});});
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
