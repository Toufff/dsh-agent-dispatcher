import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FileStore } from '../src/store.js';
import { initialState } from '../src/config.js';
import { Runtime } from '../src/runtime.js';

test('intake → format repair → timer → reply → restart/outage → completion keeps one task and session', async () => {
 const dir=await mkdtemp(path.join(os.tmpdir(),'dispatch-lifecycle-'));
 let store=await new FileStore(dir).open(), starts=0, offline=false, comments=[];
 const remoteComments=new Map();let failReport=true;
 const linear=()=>({
  issues:async()=>[{id:'parent',identifier:'EX-1',title:'Synthetic lifecycle',description:'No production work',url:'https://linear.app/example'}],
  eligible:async()=>({}),
  activity:async()=>{if(offline)throw new Error('Transient network outage');return {parentState:{type:'started'},comments};},
  report:async item=>{remoteComments.set(item.id,item);if(failReport){failReport=false;throw new Error('response lost after write');}}
 });
 const result=wait=>`<dispatch-result>${JSON.stringify({status:wait?'blocked':'complete',evidence:['synthetic verification'],remaining:wait?['receipt']:[],next:wait?'Verify dependencies before proceeding':'',progress:'new evidence',blockers:wait?[{owner:'peer',reason:'waiting',resumeWhen:'verified receipt'}]:[],...(wait?{wait}:{})})}</dispatch-result>`;
 const adapter={start:async({task,attempt})=>{
  starts++;if(starts>1){assert.equal(attempt.sessionId,'original');assert.equal(attempt.resume,true);}
  if(starts===2){assert.match(task.prompt,/Validation error/);assert.match(task.prompt,/do not execute tools/);}
  return {status:'review',sessionId:'original',summary:starts===1?'Unclassified result':starts===2?
   result({kind:'time',condition:'Check scheduled condition',notBefore:'2000-01-01T00:00:00Z'}):starts===3?
   'long narrative '.repeat(2000)+result({kind:'linear', expectedAuthorIds: ['peer'],condition:'Verify peer receipt',issueId:'child',expiresAt:new Date(Date.now()+60000).toISOString()}):result()};
 }};
 const make=async()=>{const r=await new Runtime({store,directory:dir,env:{TEST_TOKEN:'synthetic'},linearFactory:linear}).init();r.adapters.codex=adapter;return r;};
 try {
  const s=initialState();s.paused=false;s.settings.projects=[{id:'p',label:'Example',cwd:dir,followup:{enabled:true,commentAuthorIds:['peer'],maxWakeups:8},linear:{enabled:true,tokenEnv:'TEST_TOKEN',workspaceId:'w',round:'1',activeStateId:'active',reviewStateId:'review'}}];await store.save(s);
  let r=await make();await r.intake();await r.intake();await r.dispatcher.tick();await r.assess();
  assert.equal((await r.snapshot()).tasks[0].status,'queued');
  await r.dispatcher.tick();await r.assess();await r.monitor();await r.dispatcher.tick();await r.assess();await r.report();
  let t=(await r.snapshot()).tasks[0];assert.equal(t.status,'blocked');assert.equal(t.wait.kind,'linear');assert.equal(starts,3);
  await store.close();store=await new FileStore(dir).open();r=await make();
  offline=true;await r.monitor();assert.ok((await r.snapshot()).tasks[0].wait.error);
  comments=[{id:'reply',user:{id:'peer'},updatedAt:new Date(Date.now()+1000).toISOString(),body:'Receipt supplied; verify it.'}];
  offline=false;await Promise.all([r.monitor(),r.monitor()]);
  await r.dispatcher.tick();await r.assess();await r.report();await r.intake();await r.monitor();await r.dispatcher.tick();
  const final=await r.snapshot();t=final.tasks[0];
  assert.equal(final.tasks.length,1);assert.equal(starts,4);assert.equal(t.status,'review');assert.equal(t.outcome.status,'complete');
  assert.equal(t.wakeups,2);assert.equal(t.attempts.at(-1).sessionId,'original');
  assert.equal(final.outbox[0].status,'superseded');assert.equal(t.report,'sent');
  assert.ok([...remoteComments.values()].every(i=>i.stateId!=='done'));
  assert.equal(t.previousAttempts.length,3);
 } finally {await store.close();await rm(dir,{recursive:true,force:true});}
});
