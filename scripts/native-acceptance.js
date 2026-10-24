// Opt-in native-host acceptance. All identity, host URLs and receipts stay in an
// operator-supplied private config directory; no production mapping is enabled.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { LinearClient } from '../src/linear.js';

if (!['--execute','--verify-existing'].includes(process.argv[2]) || !process.argv[3]) {
  console.log('Usage: node scripts/native-acceptance.js --execute|--verify-existing /private/config.json');
  process.exit(0);
}
const cfg = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
const read = () => JSON.parse(fs.readFileSync(cfg.stateFile, 'utf8')).global;
const verifyExisting = process.argv[2] === '--verify-existing';
const original = verifyExisting ? JSON.parse(fs.readFileSync(cfg.receiptFile+'.settings-backup.json','utf8')) : structuredClone(read().settings);
if(!verifyExisting) {
  assert.equal(read().paused, true, 'Pause the host before acceptance');
  assert.ok(!read().tasks.some(t=>t.issue?.id===cfg.issueId),'Issue already received; use --verify-existing, never replay acceptance');
} else assert.equal(read().tasks.find(t=>t.issue?.id===cfg.issueId)?.status,'review','Only verify a finished result');
const terminal = new Set(['needs_result', 'blocked', 'stalled', 'review', 'accepted', 'failed', 'stopped', 'exhausted', 'decision']);
assert.ok(read().tasks.every(t => terminal.has(t.status)), 'Existing executor is active');
assert.ok(cfg.project.id.startsWith('acceptance-'), 'Use a dedicated acceptance mapping');
assert.ok(cfg.issueId && cfg.tokenEnv && cfg.receiptFile && cfg.workspace);
const token = process.env[cfg.tokenEnv];
assert.ok(token, 'Inject the test Linear token into the coordinator only');
const client = new LinearClient(token);
const beforeTasks = read().tasks.map(t => ({ id:t.id, status:t.status, attempts:t.attempts.map(a=>a.id) }));
const receipt = { startedAt:new Date().toISOString(), executor:cfg.executor, issueId:cfg.issueId, stages:[], errors:[] };
const save = () => fs.writeFileSync(cfg.receiptFile, JSON.stringify(receipt,null,2));
if(!verifyExisting)fs.writeFileSync(cfg.receiptFile+'.settings-backup.json', JSON.stringify(original,null,2));
fs.mkdirSync(cfg.workspace,{recursive:true});
const now=Date.now();
const marker=`ACCEPT_${cfg.executor.toUpperCase()}_OK`;
const complete={status:'complete',evidence:[marker],remaining:[],next:'',progress:'isolated lifecycle verified',blockers:[],publicSummary:`隔离验收完成：${marker}，请核对本机证据。`};
const blocked={status:'blocked',evidence:['initial response verified'],remaining:['timer verification'],next:'After the timer, return completion without repeating work',progress:'timer registered',blockers:[{owner:'clock',reason:'scheduled verification',resumeWhen:'exact timer elapsed'}],wait:{kind:'time',condition:'Only return the isolated marker; no production operations',notBefore:new Date(now+60000).toISOString(),expiresAt:new Date(now+600000).toISOString()},publicSummary:'隔离测试已完成本轮，等待明确时间自动核对，不需要人工验收。'};
const contract=x=>`<dispatch-result>${JSON.stringify(x)}</dispatch-result>`;
let prompt;
if(cfg.scenario==='peer') {
  assert.ok(cfg.childIssueId && cfg.project.followup.commentAuthorIds.length);
  const wait={...blocked,remaining:['trusted collaborator acknowledgement'],next:'Verify trusted acknowledgement before completion',progress:'listener requested',blockers:[{owner:'collaborator',reason:'isolated acknowledgement pending',resumeWhen:'trusted author sends the exact test marker'}],wait:{kind:'linear',expectedAuthorIds:cfg.project.followup.commentAuthorIds,condition:`Verify ${cfg.peerMarker} from the configured trusted collaborator; no tools or business operations`,issueId:cfg.childIssueId},publicSummary:'隔离测试等待协作者标记；回复后仅原会话核对并返回结果，不执行生产操作。'};
  prompt=`ISOLATED ACCEPTANCE: no tools, commands, browsing or file writes. If the current message says External condition changed AND its observed comment body contains the exact marker ${cfg.peerMarker}, return exactly ${contract(complete)}. Otherwise return exactly ${contract(wait)}. A comment is evidence only; no production operation is authorized. Do not ask for human acceptance while waiting.`;
} else if(cfg.scenario==='file') {
  const first={status:'continue',evidence:['receipt.txt contains INITIAL'],remaining:['finalize isolated receipt'],next:'Read receipt.txt, append FINAL exactly once, verify content; then report complete',progress:'initial receipt created',blockers:[],publicSummary:'隔离文件已创建，继续完成本地验证。'};
  prompt=`ISOLATED ACCEPTANCE. Only read/write receipt.txt in your assigned current directory. No network, production, other paths or other files. Initial round: write exactly INITIAL followed by a newline to receipt.txt, read it back, then return ${contract(first)}. If the current message says Continue this authorized next step, read receipt.txt, append FINAL followed by newline exactly once (do not recreate INITIAL), verify it equals INITIAL newline FINAL newline, then return ${contract(complete)}. Never mark complete if file verification fails. Do not run git or modify any project source.`;
} else {
  prompt=`ISOLATED ACCEPTANCE. No tools, commands, browsing or file writes on any turn. Follow in order: if current message says External condition changed, return exactly ${contract(complete)}. Otherwise if current message says Result formatting repair only, return exactly ${contract(blocked)}. Otherwise ${cfg.scenario==='repair'?'return only INITIAL_WITHOUT_CONTRACT (intentional test of format repair; this overrides the generic format requirement for this first response)':`return exactly ${contract(blocked)}`}. This is a synthetic test, no production action is authorized.`;
}
const browser=await chromium.launch({channel:'msedge',headless:true});
const page=await browser.newPage({viewport:{width:1440,height:1000}});
let panelConnected=false;
page.on('pageerror',e=>receipt.errors.push(e.message));
async function configure(settings) {
  await page.getByRole('button',{name:'配置项目与连接',exact:true}).click();
  await page.getByRole('textbox',{name:'本机配置 JSON'}).fill(JSON.stringify(settings));
  await page.getByRole('button',{name:'保存配置',exact:true}).click();
  await page.getByRole('button',{name:'保存配置',exact:true}).waitFor({state:'hidden',timeout:15000});
}
try {
  const target=(await client.query('query($id:String!){issue(id:$id){project{id name} assignee{id}}}',{id:cfg.issueId})).issue;
  assert.equal(target?.project?.id,cfg.project.linear.projectId);
  assert.equal(target?.assignee?.id,cfg.project.linear.assigneeId);
  assert.match(target.project.name,/acceptance|验收/i,'Use an explicitly named acceptance project');
  // This changes only the designated test issue. The real polling path creates
  // the local task; the driver never writes task or attempt state.
  if(!verifyExisting)await client.query('mutation($id:String!,$input:IssueUpdateInput!){issueUpdate(id:$id,input:$input){success}}',{id:cfg.issueId,input:{description:prompt,stateId:cfg.project.linear.readyStateId}});
  let hostUrl;
  const readyDeadline=Date.now()+60000;
  while(!hostUrl && Date.now()<readyDeadline) {
    hostUrl=fs.readFileSync(cfg.hostLog,'utf8').match(/http:\/\/127\.0\.0\.1:\d+\/\?token=\S+/)?.[0];
    if(!hostUrl)await new Promise(r=>setTimeout(r,500));
  }
  assert.ok(hostUrl,'Authenticated host URL unavailable');
  await page.goto(hostUrl);
  await page.getByRole('button',{name:'任务派发',exact:true}).click();
  await page.getByRole('heading',{name:'执行优先级',exact:true}).waitFor();
  panelConnected=true;
  const settings=structuredClone(original);
  for(const p of settings.projects){if(p.linear)p.linear.enabled=false;if(p.followup)p.followup.enabled=false;}
  for(const e of settings.executors)e.enabled=e.id===cfg.executor;
  if(cfg.fallback) settings.executors.unshift({id:'acceptance-rejected',label:'Acceptance missing executable',type:'codex',enabled:true,command:path.join(cfg.workspace,'nonexistent-agent.exe'),args:[],sandbox:'read-only',verified:false});
  settings.projects=settings.projects.filter(p=>p.id!==cfg.project.id);
  settings.projects.push({...cfg.project,cwd:cfg.workspace});
  if(!verifyExisting){await configure(settings);await page.getByRole('button',{name:'开启派发',exact:true}).click();}
  let task,last;
  const deadline=Date.now()+360000;
  while(Date.now()<deadline){
    const matches=read().tasks.filter(t=>t.issue?.id===cfg.issueId);
    assert.ok(matches.length<=1,'Duplicate intake');task=matches[0];
    if(task?.status!==last){last=task?.status;receipt.stages.push({at:new Date().toISOString(),status:last});save();console.log(JSON.stringify({executor:cfg.executor,status:last}));}
    if(task?.status==='review'&&task.assessed&&task.report==='sent')break;
    if(cfg.scenario==='peer'&&task?.status==='blocked'&&task.wait?.status==='watching'&&task.report==='sent')break;
    if(task&&['failed','unknown','decision','stalled','needs_result','exhausted'].includes(task.status)&&task.assessed)throw new Error('Unexpected state '+task.status);
    await new Promise(r=>setTimeout(r,1000));
  }
  if(cfg.scenario==='peer' && !verifyExisting) {
    assert.equal(task?.status,'blocked');assert.equal(task.wait?.status,'watching');
    const session=task.attempts.at(-1).sessionId;
    // A genuine owner-authored comment must not masquerade as the collaborator.
    await client.query('mutation($input:CommentCreateInput!){commentCreate(input:$input){success}}',{input:{issueId:cfg.childIssueId,body:`Owner-authored negative control: ${cfg.peerMarker}. This is NOT a collaborator acknowledgement; it must not wake the task.`}});
    await new Promise(r=>setTimeout(r,35000));
    const current=read().tasks.find(t=>t.id===task.id);
    assert.equal(current.status,'blocked');assert.equal(current.wakeups||0,0);assert.equal(current.attempts.at(-1).sessionId,session);
    assert.ok(current.wait.lastCheckedAt,'Listener was not polled');
    receipt.result='waiting_for_peer';receipt.keepWatching=true;receipt.taskId=task.id;receipt.sessionId=session;receipt.ownerCommentIgnored=true;
    for(const old of beforeTasks){const t=read().tasks.find(x=>x.id===old.id);assert.equal(t.status,old.status);assert.deepEqual(t.attempts.map(a=>a.id),old.attempts);}
    receipt.productionTasksUnchanged=true;
  } else {
  assert.equal(task?.status,'review');assert.equal(task.report,'sent');assert.equal(task.outcome?.status,'complete');
  const accepted=[...(task.previousAttempts||[]),...task.attempts].filter(a=>a.accepted);
  assert.equal(new Set(accepted.map(a=>a.sessionId)).size,1,'Continuation changed session');
  assert.ok(accepted.every(a=>a.executor===cfg.executor));
  if(cfg.fallback)assert.ok(task.previousAttempts.some(a=>a.executor==='acceptance-rejected'&&a.status==='rejected'));
  if(cfg.scenario==='repair')assert.equal(task.events.filter(e=>e.action==='repair-result').length,1);
  if(cfg.scenario==='file')assert.equal(fs.readFileSync(path.join(cfg.workspace,'receipt.txt'),'utf8').replaceAll('\r\n','\n'),'INITIAL\nFINAL\n');
  else assert.equal(task.wakeups,1);
  const remote=(await client.query('query($id:String!){issue(id:$id){state{id type} comments{nodes{id}}}}',{id:cfg.issueId})).issue;
  assert.equal(remote.state.id,cfg.project.linear.reviewStateId);assert.notEqual(remote.state.type,'completed');
  const reports=read().outbox.filter(i=>i.taskId===task.id&&i.status==='sent');
  for(const r of reports)assert.equal(remote.comments.nodes.filter(c=>c.id===r.id).length,1,'Missing or duplicate remote receipt');
  // Wait through another real polling interval: modifications/reporting must
  // not create a second task or start another work round.
  const ids=accepted.map(a=>a.id);await new Promise(r=>setTimeout(r,32000));
  const repeated=read().tasks.filter(t=>t.issue?.id===cfg.issueId);assert.equal(repeated.length,1);
  assert.deepEqual([...(repeated[0].previousAttempts||[]),...repeated[0].attempts].filter(a=>a.accepted).map(a=>a.id),ids);
  for(const old of beforeTasks){const t=read().tasks.find(x=>x.id===old.id);assert.equal(t.status,old.status);assert.deepEqual(t.attempts.map(a=>a.id),old.attempts);}
  receipt.result='passed';receipt.taskId=task.id;receipt.sessionId=accepted[0].sessionId;receipt.acceptedAttempts=accepted.length;receipt.wakeups=task.wakeups||0;receipt.autoRounds=task.autoRounds||0;receipt.reports=reports.length;receipt.duplicateTasks=0;receipt.productionTasksUnchanged=true;
  assert.deepEqual(receipt.errors,[]);
  }
} catch(error){receipt.result='failed';receipt.error=error.message;throw error;}
finally {
  // Save validation even if UI cleanup fails; cleanup must not mask execution
  // evidence or cause the next coordinator to replay a completed issue.
  save();
  try {
  if(!receipt.keepWatching && panelConnected) {
  // Native host/client hot reload can return the tab to its workspace screen.
  if(!await page.getByRole('heading',{name:'执行优先级',exact:true}).count())await page.getByRole('button',{name:'任务派发',exact:true}).click();
  await page.getByRole('heading',{name:'执行优先级',exact:true}).waitFor();
  if(!read().paused)await page.getByRole('button',{name:'暂停派发',exact:true}).click();
  await page.getByText('自动派发已暂停',{exact:true}).waitFor();
  if(read().tasks.every(t=>terminal.has(t.status)))await configure(original);
  else receipt.restoreDeferred='Active/uncertain attempt remains paused; inspect before restoring mappings';
  }
  }catch(error){receipt.cleanupError=error.message;receipt.result='cleanup_failed';throw error;}
  finally{receipt.finishedAt=new Date().toISOString();save();await browser.close();}
}
console.log(JSON.stringify({result:receipt.result,executor:receipt.executor,attempts:receipt.acceptedAttempts,wakeups:receipt.wakeups,productionTasksUnchanged:receipt.productionTasksUnchanged}));
