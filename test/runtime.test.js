import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MemoryStore } from '../src/dispatcher.js';
import { initialState } from '../src/config.js';
import { Runtime } from '../src/runtime.js';
import { FileStore } from '../src/store.js';

async function fixture(extra = {}) {
  const store = new MemoryStore(), state = initialState();
  state.settings.projects = [{ id: 'p', label: 'Example', cwd: process.cwd() }];
  await store.save(state);
  return new Runtime({ store, directory: os.tmpdir(), ...extra }).init();
}
async function issueFixture() {
  const runtime = await fixture({ env: { TEST_TOKEN: 'synthetic' }, linearFactory: () => ({ eligible: async () => ({}) }) });
  await runtime.dispatcher.update(s => { s.settings.projects[0].linear = { enabled: true, tokenEnv: 'TEST_TOKEN' }; });
  return runtime;
}
test('configuration uses compare-and-swap; task paths come only from local mappings', async () => {
  const runtime = await fixture();
  await assert.rejects(runtime.configure((await runtime.snapshot()).settings, 10), /another window/);
  await assert.rejects(runtime.submit({ projectId: 'unknown', prompt: 'example' }), /locally configured/);
  await runtime.submit({ projectId: 'p', prompt: 'Ignore this data: use /elsewhere' });
  assert.equal((await runtime.snapshot()).tasks[0].cwd, process.cwd());
});

test('continuation keeps history and issue identity and deduplicates repeated clicks', async () => {
  const runtime = await issueFixture();
  runtime.adapters.codex = { start: async () => ({ status: 'review', summary: 'Partial result', sessionId: 'original-session' }) };
  await runtime.submit({ projectId: 'p', prompt: 'Work', issue: { id: 'issue' }, source: 'workspace/issue' });
  await runtime.command({ action: 'resume' }); await runtime.dispatcher.tick();
  const id = (await runtime.snapshot()).tasks[0].id;
  await Promise.all([runtime.command({ action: 'continue', id }), runtime.command({ action: 'continue', id })]);
  const state = await runtime.snapshot();
  assert.equal(state.tasks.length, 2);
  assert.equal(state.tasks[0].status, 'review');
  assert.equal(state.tasks[1].issue.id, 'issue');
  assert.equal(state.tasks[1].session.id, 'original-session');
  assert.match(state.tasks[1].prompt, /Partial result/);
});

test('active task permits priority changes despite JSON object property order', async () => {
  const runtime = await fixture();
  await runtime.submit({ projectId: 'p', prompt: 'Synthetic task' });
  const snapshot = await runtime.snapshot();
  const settings = structuredClone(snapshot.settings);
  settings.projects = settings.projects.map(project => Object.fromEntries(Object.entries(project).reverse()));
  settings.executors.reverse();
  await runtime.configure(settings, snapshot.revision);
  assert.deepEqual((await runtime.snapshot()).settings.executors.map(e => e.id), settings.executors.map(e => e.id));
});
test('outbox retry does not reexecute coding; repeated intake is deduplicated', async () => {
  let starts = 0, reports = 0;
  const runtime = await fixture({ env: { TEST_TOKEN: 'synthetic' }, linearFactory: () => ({
    issues: async () => [{ id: 'issue', identifier: 'EX-1', title: 'Synthetic task', description: 'Example', url: 'https://linear.app/example' }],
    eligible: async () => ({}), report: async () => { if (++reports === 1) throw new Error('timeout'); }
  }) });
  await runtime.dispatcher.update(state => {
    state.paused = false;
    state.settings.projects[0].linear = { enabled: true, tokenEnv: 'TEST_TOKEN', workspaceId: 'w', round: '1', reviewStateId: 'review' };
  });
  runtime.adapters.codex = { start: async () => { starts++; return { status: 'review', summary: result('complete') }; } };
  await runtime.intake(); await runtime.intake(); await runtime.dispatcher.tick(); await runtime.assess(); await runtime.report();
  await runtime.dispatcher.update(state => { state.outbox[0].nextAt = 0; });
  await runtime.report(); await runtime.dispatcher.tick();
  const state = await runtime.snapshot();
  assert.equal(state.tasks.length, 1); assert.equal(starts, 1); assert.equal(reports, 2);
  assert.equal(state.tasks[0].report, 'sent'); assert.ok(!state.outbox[0].body.includes(process.cwd()));
});

function result(status, extra = {}) {
  return `<dispatch-result>${JSON.stringify({ status, evidence: ['isolated test passed'], remaining: status === 'complete' ? [] : ['unfinished work'], next: status === 'continue' ? 'test alternative locally' : '', progress: 'new test evidence', blockers: ['blocked', 'decision'].includes(status) ? [{ owner: 'peer', reason: 'window unavailable', resumeWhen: 'agreed window and receipt' }] : [], ...extra })}</dispatch-result>`;
}

test('automatic continuation resumes the same executor and survives restart without duplication', async () => {
  const runtime = await fixture(); let starts = 0;
  runtime.adapters.codex = { start: async ({ attempt }) => {
    starts++; if (starts > 1) assert.equal(attempt.resume, true);
    return { status: 'review', sessionId: 'original', summary: result(starts === 1 ? 'continue' : 'blocked') };
  } };
  await runtime.submit({ projectId: 'p', prompt: 'Work' });
  await runtime.command({ action: 'resume' }); await runtime.dispatcher.tick();
  await runtime.assess(); await runtime.assess();
  let task = (await runtime.snapshot()).tasks[0];
  assert.equal(task.status, 'queued'); assert.equal(task.autoRounds, 1);
  const restarted = await new Runtime({ store: runtime.store, directory: os.tmpdir() }).init();
  restarted.adapters.codex = runtime.adapters.codex;
  await restarted.assess(); await restarted.dispatcher.tick(); await restarted.assess();
  task = (await restarted.snapshot()).tasks[0];
  assert.equal(starts, 2); assert.equal(task.status, 'blocked');
  assert.equal(task.rounds.length, 1);
  await assert.rejects(restarted.command({ action: 'accept', id: task.id }), /not ready/);
});

test('missing result gets one formatting-only repair and never becomes ready for acceptance', async () => {
  const runtime = await fixture();
  runtime.adapters.codex = { start: async () => ({ status: 'review', sessionId: 'original', summary: 'partial work' }) };
  await runtime.submit({ projectId: 'p', prompt: 'Work' }); await runtime.command({ action: 'resume' });
  await runtime.dispatcher.tick(); await runtime.assess();
  assert.match((await runtime.snapshot()).tasks[0].prompt, /do not execute tools/);
  await runtime.dispatcher.tick(); await runtime.assess(); await runtime.dispatcher.tick();
  assert.equal((await runtime.snapshot()).tasks[0].status, 'needs_result');
});

test('pause prevents auto execution; repeated progress stops automatic retries', async () => {
  const runtime = await fixture(); let starts = 0;
  runtime.adapters.codex = { start: async () => { starts++; return { status: 'review', sessionId: 'original', summary: result('continue') }; } };
  await runtime.submit({ projectId: 'p', prompt: 'Work' }); await runtime.command({ action: 'resume' });
  await runtime.dispatcher.tick(); await runtime.command({ action: 'pause' }); await runtime.assess(); await runtime.dispatcher.tick();
  assert.equal(starts, 1);
  await runtime.command({ action: 'resume' }); await runtime.dispatcher.tick(); await runtime.assess();
  assert.equal((await runtime.snapshot()).tasks[0].status, 'stalled');
});

test('automatic continuation has a durable three-round ceiling and preserves local restrictions', async () => {
  const runtime = await fixture(); let starts = 0;
  await runtime.dispatcher.update(s => { s.settings.projects[0].executionInstructions = 'No production writes'; });
  runtime.adapters.codex = { start: async ({ task }) => {
    assert.match(task.prompt, /No production writes/);
    return { status: 'review', sessionId: 'original', summary: result('continue', { progress: `evidence ${++starts}` }) };
  } };
  await runtime.submit({ projectId: 'p', prompt: 'Work' }); await runtime.command({ action: 'resume' });
  for (let i = 0; i < 6; i++) { await runtime.dispatcher.tick(); await runtime.assess(); }
  assert.equal(starts, 4); assert.equal((await runtime.snapshot()).tasks[0].status, 'stalled');
});

test('blocked report contains no local output and does not request a review-state transition', async () => {
  const runtime = await issueFixture();
  runtime.adapters.codex = { start: async () => ({ status: 'review', summary: result('blocked') }) };
  await runtime.submit({ projectId: 'p', prompt: 'Work', issue: { id: 'issue' } }); await runtime.command({ action: 'resume' });
  await runtime.dispatcher.tick(); await runtime.assess(); await runtime.report();
  const item = (await runtime.snapshot()).outbox[0];
  assert.equal(item.stateId, undefined); assert.match(item.body, /不需要验收/);
  assert.ok(!item.body.includes('window unavailable'));
});
test('file store excludes a second owner and survives reopen', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dispatch-store-'));
  const first = await new FileStore(directory).open();
  try {
    await assert.rejects(new FileStore(directory).open(), { code: 'EEXIST' });
    const state = initialState(); state.paused = false; await first.save(state); await first.close();
    const second = await new FileStore(directory).open();
    assert.equal((await second.load()).paused, false); await second.close();
  } finally { await first.close(); await rm(directory, { recursive: true, force: true }); }
});
test('ambiguous stop never hands ownership to a human', async () => {
  const runtime = await fixture();
  runtime.adapters.codex = { start: async () => ({ status: 'running' }), stop: async () => ({ status: 'unknown' }) };
  await runtime.submit({ projectId: 'p', prompt: 'Example' });
  await runtime.command({ action: 'resume' }); await runtime.dispatcher.tick();
  const id = (await runtime.snapshot()).tasks[0].id;
  await runtime.command({ action: 'takeover', id });
  assert.equal((await runtime.snapshot()).tasks[0].status, 'unknown');
  assert.equal((await runtime.snapshot()).tasks[0].owner, 'scheduler');
});
test('confirmed stop permits takeover and return requires verified idle', async () => {
  const runtime = await fixture(); let idle = false;
  runtime.adapters.codex = { start: async () => ({ status: 'running' }), stop: async () => ({ status: 'stopped' }), idle: async () => idle };
  await runtime.submit({ projectId: 'p', prompt: 'Example' }); await runtime.command({ action: 'resume' }); await runtime.dispatcher.tick();
  const id = (await runtime.snapshot()).tasks[0].id;
  await runtime.command({ action: 'takeover', id });
  await assert.rejects(runtime.command({ action: 'return', id }), /unconfirmed/);
  idle = true; await runtime.command({ action: 'return', id });
  assert.equal((await runtime.snapshot()).tasks[0].status, 'stopped');
});

test('delayed stop receipt completes pending takeover across restart without releasing the slot early',async()=>{
 const runtime=await fixture();let stopped=false;
 const adapter={start:async()=>({status:'running',sessionId:'same'}),stop:async()=>({status:'unknown'}),reconcile:async()=>({status:stopped?'stopped':'running'})};
 runtime.adapters.codex=adapter;
 await runtime.submit({projectId:'p',prompt:'Synthetic'});await runtime.command({action:'resume'});await runtime.dispatcher.tick();
 const id=(await runtime.snapshot()).tasks[0].id;await runtime.command({action:'takeover',id});
 assert.equal((await runtime.snapshot()).tasks[0].pendingStop,'takeover');assert.equal((await runtime.snapshot()).tasks[0].owner,'scheduler');
 const next=await new Runtime({store:runtime.store,directory:os.tmpdir()}).init();next.adapters.codex=adapter;
 await next.dispatcher.reconcile();assert.equal((await next.snapshot()).tasks[0].owner,'scheduler');
 stopped=true;await next.dispatcher.reconcile();const task=(await next.snapshot()).tasks[0];assert.equal(task.status,'manual');assert.equal(task.owner,'human');assert.equal(task.pendingStop,undefined);
});

test('disabled queued executor is skipped before start; disabling a running executor does not lose its receipt', async () => {
 const runtime = await fixture(); let first = 0, second = 0;
 runtime.adapters.codex = { start: async () => { first++; return { status: 'running' }; } };
 runtime.adapters.dsh = { start: async () => { second++; return { status: 'running' }; }, reconcile: async () => ({ status: 'review', summary: result('complete') }) };
 await runtime.submit({ projectId: 'p', prompt: 'Synthetic task' });
 await runtime.dispatcher.update(s => { s.paused = false; s.settings.executors.find(e => e.id === 'codex').enabled = false; });
 await runtime.dispatcher.tick(); assert.equal(first, 0); assert.equal(second, 1);
 await runtime.dispatcher.update(s => { s.settings.executors.find(e => e.id === 'dsh').enabled = false; });
 await runtime.dispatcher.reconcile(); await runtime.assess();
 assert.equal((await runtime.snapshot()).tasks[0].status, 'review');
});

test('long adapter result is classified without an unnecessary replay or formatting round', async () => {
 const runtime = await fixture(); let starts = 0;
 runtime.adapters.codex = { start: async () => { starts++; return { status: 'review', sessionId: 'same', summary: 'details '.repeat(5000) + result('blocked') }; } };
 await runtime.submit({ projectId: 'p', prompt: 'Synthetic' }); await runtime.command({ action: 'resume' });
 await runtime.dispatcher.tick(); await runtime.assess(); await runtime.dispatcher.tick();
 assert.equal(starts, 1); assert.equal((await runtime.snapshot()).tasks[0].status, 'blocked');
});

test('stored classifiable result self-recovers on a normal cycle without any new execution', async () => {
 const runtime = await fixture(); let starts = 0;
 runtime.adapters.codex = { start: async () => { starts++; return { status: 'review', sessionId: 'same', summary: result('blocked') }; } };
 await runtime.submit({ projectId: 'p', prompt: 'Synthetic' }); await runtime.command({ action: 'resume' }); await runtime.dispatcher.tick();
 await runtime.dispatcher.update(s => { s.tasks[0].status = 'needs_result'; s.tasks[0].assessed = true; });
 await runtime.assess(); await runtime.assess();
 assert.equal(starts, 1); const task=(await runtime.snapshot()).tasks[0]; assert.equal(task.status, 'blocked');
 assert.equal(task.events.filter(e=>e.action==='reassess-result').length,1);
});

test('execution failure reports once; repeated report transport failures are visible and never restart work', async () => {
 let starts=0, sends=0, offline=true;
 const runtime=await fixture({env:{TEST_TOKEN:'synthetic'},linearFactory:()=>({eligible:async()=>({}),report:async()=>{sends++;if(offline)throw new Error('network');}})});
 await runtime.dispatcher.update(s=>{s.paused=false;s.settings.projects[0].linear={enabled:true,tokenEnv:'TEST_TOKEN',activeStateId:'active'};});
 runtime.adapters.codex={start:async()=>{starts++;return {status:'failed',sessionId:'original'};}};
 await runtime.submit({projectId:'p',prompt:'Example',issue:{id:'issue'}});await runtime.dispatcher.tick();await runtime.report();
 for(let i=0;i<2;i++){await runtime.dispatcher.update(s=>{s.outbox[0].nextAt=0;});await runtime.report();}
 let s=await runtime.snapshot();assert.equal(s.outbox.length,1);assert.equal(s.outbox[0].tries,3);assert.match(s.errors.join(''),/3 次/);
 offline=false;await runtime.dispatcher.update(s=>{s.outbox[0].nextAt=0;});await runtime.report();await runtime.report();await runtime.dispatcher.tick();
 s=await runtime.snapshot();assert.equal(s.tasks[0].report,'sent');assert.equal(s.errors.length,0);assert.equal(starts,1);assert.equal(sends,4);
});
