import test from 'node:test';
import assert from 'node:assert/strict';
import { waitView, formatTime, waitDraftFor } from '../src/ui/wait-view.js';
const now = Date.parse('2030-01-01T04:00:00Z');
const wait = { kind: 'linear', issueId: 'child', condition: 'Provide a verified receipt', status: 'watching', lastCheckedAt: new Date(now).toISOString(), expiresAt: '2030-01-01T05:00:00Z' };
const task = { status: 'blocked', projectId: 'p', issue: { id: 'parent' }, wait,
  outcome: { wait, next: 'Verify before proceeding', blockers: [{ owner: 'Collaborator', reason: 'Receipt is missing', resumeWhen: 'Receipt arrives' }] } };
const data = { paused: false, settings: { projects: [{ id: 'p', linear: { enabled: true }, followup: { enabled: true, observeAfterExpiry: true } }] }, tasks: [{ issue: { id: 'child', identifier: 'TEST-2', url: 'https://linear.app/example/issue/TEST-2' } }] };

test('invalid target is a configuration fault, not a retrying network failure or expired window', () => {
  const v = waitView({ ...task, wait: { ...wait, status: 'invalid', error: 'invalid target', errorCount: 7 } }, data, now + 7200000);
  assert.equal(v.title, '等待配置需要修正'); assert.equal(v.monitor, '配置错误，已停止重试');
});

test('waiting view identifies collaborator, actual blocker and linked issue', () => {
  const v = waitView(task, data, now);
  assert.equal(v.reason, 'Receipt is missing'); assert.equal(v.owners, 'Linear 回复者待核对');
  assert.equal(v.targetLabel, 'TEST-2'); assert.equal(v.targetUrl, data.tasks[0].issue.url);
  assert.equal(v.monitor, '自动检查已开启');
});
test('rearming does not promote previous result blockers to current facts', () => {
  const v = waitView({ ...task, wait: { ...wait, condition: 'A newly confirmed condition' } }, data, now);
  assert.equal(v.reason, 'A newly confirmed condition'); assert.equal(v.owners, 'Linear 回复者待核对'); assert.equal(v.next, null);
});
test('Linear identity overrides role prose and keeps assignment separate from reply permissions', () => {
  const withContext = { ...data, issueContexts: { current: { status: 'ready',
    source: { assignee: { name: 'Owner Name' } },
    target: { id: 'child', identifier: 'TEST-2', title: 'Receipt', assignee: { id: 'peer', name: 'Full Name', displayName: 'Reviewer' } },
    replyUsers: [{ id: 'peer', name: 'Full Name', displayName: 'Reviewer' }] } } };
  const v = waitView({ ...task, id: 'current' }, withContext, now);
  assert.equal(v.title, '等待 Full Name 回复'); assert.equal(v.owners, 'Full Name');
  assert.equal(v.sourceAssignee, 'Owner Name'); assert.equal(v.assignmentMismatch, false);
  withContext.issueContexts.current.target.assignee.id = 'untrusted';
  assert.equal(waitView({ ...task, id: 'current' }, withContext, now).assignmentMismatch, true);
});
test('paused, disabled and failed checks never claim active monitoring', () => {
  assert.equal(waitView(task, { ...data, paused: true }, now).monitor, '派发已暂停');
  const disabled = structuredClone(data); disabled.settings.projects[0].followup.enabled = false;
  assert.equal(waitView(task, disabled, now).monitor, '项目自动恢复未启用');
  assert.equal(waitView({ ...task, wait: { ...wait, error: 'offline' } }, data, now).monitor, '条件检查失败，正在重试');
  assert.equal(waitView({ ...task, owner: 'human' }, data, now).monitor, '人工接管中，自动恢复暂停');
});
test('expiry uses actual time before the next scheduler poll and distinguishes observation', () => {
  const v = waitView(task, data, now + 3600001);
  assert.equal(v.title, '等待窗口已过期'); assert.equal(v.monitor, '仅观察新回复，不会启动执行');
  assert.equal(waitView(task, { ...data, paused: true }, now + 3600001).monitor, '不会自动执行');
});
test('stale checks, missing wait and exhausted wakeups explain recovery', () => {
  assert.equal(waitView(task, data, now + 91000).monitor, '检查记录超过 90 秒未更新');
  assert.equal(waitView({ ...task, wait: null }, data, now).monitor, '未设置自动恢复条件');
  assert.equal(waitView({ ...task, wait: { ...wait, status: 'limit' } }, data, now).monitor, '不会自动执行');
});
test('time waits and active tasks are not mislabeled as collaborator waits', () => {
  assert.equal(waitView({ ...task, wait: { ...wait, kind: 'time', notBefore: '2030-01-01T04:30:00Z' } }, data, now).title, '等待约定时间');
  assert.equal(waitView({ ...task, status: 'running' }, data, now), null);
  assert.equal(waitView({ ...task, status: 'decision' }, data, now).monitor, '等待决策，不会自动执行');
  assert.equal(waitView({ ...task, status: 'stopped' }, data, now).monitor, '监听已停止');
  assert.equal(waitView({ ...task, status: 'stalled' }, data, now).monitor, '不会自动执行');
  assert.equal(waitView({ ...task, status: 'stopped', wait: null }, data, now), null);
  assert.equal(formatTime('bad'), '时间格式无效');
});

test('local dependency shows target and trigger source without misleading peer warning',()=>{
  const dependency={id:'dep',status:'running',title:'Verification task',issue:{id:'child',identifier:'TEST-2'}};
  const t={...task,wait:{kind:'task',taskId:'dep',issueId:'child',condition:'result',status:'watching'}};
  const v=waitView(t,{...data,tasks:[dependency]},now);
  assert.equal(v.title,'等待本机任务 TEST-2 完成');assert.equal(v.dependencyStatus,'running');assert.equal(v.assignmentMismatch,false);
  assert.match(v.action,/持久完成回执/);assert.equal(v.identityStatus,null);
});


test('editing a local dependency preserves exact target and legacy replies require explicit authors',()=>{
 assert.deepEqual(waitDraftFor({issue:{id:'source'},wait:{kind:'task',taskId:'target',condition:'result'}}),{kind:'task',taskId:'target',condition:'result'});
 assert.deepEqual(waitDraftFor(task).expectedAuthorIds,[]);
});
