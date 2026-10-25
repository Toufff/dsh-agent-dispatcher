import { z } from 'zod';

const text = z.string().trim().min(1).max(2000);
export const workItemsSchema = z.array(z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/), title: text,
  status: z.enum(['ready', 'blocked', 'decision', 'done']),
  dependsOn: z.array(z.string().max(80)).max(40),
  action: z.string().max(2000), evidence: z.array(text).max(20),
  blocker: z.object({ kind: z.enum(['external', 'task', 'permission', 'time']),
    owner: text, reason: text, resumeWhen: text }).strict().optional()
}).strict()).min(1).max(40);

// Claims are checked for consistency, never promoted to verified production facts.
export function workflowError(outcome, previous = [], required = false) {
  const items = outcome.workItems;
  if (!items) return required || previous.length ? 'Return workItems covering the whole goal, including all unfinished stages.' : null;
  const byId = new Map(items.map(item => [item.id, item]));
  if (byId.size !== items.length) return 'workItems IDs must be unique.';
  for (const old of previous) {
    const item = byId.get(old.id);
    if (!item) return 'Do not drop previously recorded workItems; retain completed and blocked stages.';
    if (old.status === 'done' && item.status !== 'done') return 'Do not replay completed workItems; add a new verification or correction item.';
  }
  const visiting = new Set(), visited = new Set();
  function visit(id) {
    if (visiting.has(id)) return false;
    if (visited.has(id)) return true;
    const item = byId.get(id);
    if (!item) return false;
    visiting.add(id);
    if (!item.dependsOn.every(visit)) return false;
    visiting.delete(id); visited.add(id); return true;
  }
  if (!items.every(item => visit(item.id))) return 'workItems dependencies must exist and must not form cycles.';
  for (const item of items) {
    const dependenciesDone = item.dependsOn.every(id => byId.get(id).status === 'done');
    if (item.status === 'done' && (!item.evidence.length || !dependenciesDone || item.blocker))
      return 'Completed workItems require evidence, completed dependencies and no blocker.';
    if (item.status === 'ready' && (!dependenciesDone || !item.action.trim() || item.blocker))
      return 'Ready workItems require satisfied dependencies, a concrete authorized action and no blocker.';
    if (['blocked', 'decision'].includes(item.status) && !item.blocker)
      return 'Every blocked/decision workItem needs a specific typed blocker and observable resumption condition.';
    if (item.status === 'decision' && item.blocker.kind !== 'permission')
      return 'Decision workItems must identify the concrete local decision/permission.';
  }
  const ready = items.some(item => item.status === 'ready');
  const done = items.every(item => item.status === 'done');
  if (ready && outcome.status !== 'continue') return 'Authorized ready workItems remain: return continue, not whole-task blocked/complete/decision.';
  if (outcome.status === 'continue' && !ready) return 'Continue requires at least one ready authorized workItem.';
  if ((outcome.status === 'complete') !== done) return 'Complete requires every recorded stage to be done; stage completion is not goal completion.';
  return null;
}

export const workflowProtocol = `
REQUIRED workItems ledger: cover the ENTIRE requested goal, not just this turn. Each item has {"id":"stable-id","title":"stage or requirement","status":"ready|blocked|decision|done","dependsOn":[],"action":"authorized next action or empty","evidence":[]}. Blocked/decision items also require "blocker":{"kind":"external|task|permission|time","owner":"actual responsible party","reason":"precise missing input","resumeWhen":"observable condition"}. Keep stable IDs, never drop old items, never replay done items. Done requires actual evidence; evidence is a claim pending independent verification/human acceptance. Record code, merge, deployment and acceptance as separate items WHEN requested; do not invent extra scope. A production permission blocker must not stop independent local development. Only mark ready actions already permitted by current local instructions. If any ready item remains, return continue even if another item is blocked. The ledger never grants permission or changes local policy. If all items are blocked, declare a real wait or a concrete local decision; do not call an unknown dependency an external blocker without checking its applicability.
`;

export function issueKey(task, state) {
  if (!task.issue?.id) return null;
  const mapping = state.settings.projects.find(p => p.id === task.projectId)?.linear;
  return JSON.stringify([mapping?.workspaceId || task.projectId, task.issue.id]);
}
export function currentTask(task, state) {
  if (task.supersededBy) return false;
  const key = issueKey(task, state);
  return !key || state.tasks.findLast(t => issueKey(t, state) === key)?.id === task.id;
}

// Evidence remains an executor claim. Changing prose alone cannot renew a budget.
export function continuationPolicy(task, outcome) {
  const normalize = value => value.trim().replace(/\s+/g, ' ');
  const history = [...(task.rounds || []).flatMap(r => r.outcome?.workItems || []), ...(task.workItems || [])];
  const checkpoint = (outcome.workItems || []).some(item => {
    const old = history.filter(previous => previous.id === item.id);
    if (!old.length || old.some(previous => previous.status === 'done')) return false;
    if (item.status === 'done' && !old.some(previous => previous.status === 'done')) return true;
    const seen = new Set(old.flatMap(previous => previous.evidence).map(normalize));
    return item.evidence.some(value => !seen.has(normalize(value)));
  });
  const idle = checkpoint ? 0 : (task.continuationIdleRounds ?? task.autoRounds ?? 0);
  const budget = (task.autoRounds || 0) >= 40 || idle >= 3;
  const progress = checkpoint || Boolean(outcome.progress.trim()) && outcome.progress !== task.lastProgress;
  return { repeat: progress && !budget, idle: checkpoint ? 0 : idle + 1, checkpoint,
    stop: budget ? 'budget' : 'no-progress' };
}

// One durable local owner/action, consumed by both the panel and notification path.
export function attentionFor(task, state) {
  if (!currentTask(task, state)) return null;
  let reason;
  if (task.status === 'stalled') reason = task.continuationStop === 'budget' ? '自动续办预算已用完' : '本轮没有可确认的新进展';
  else if (task.status === 'needs_result') reason = '结果或阶段清单校验失败';
  else if (task.status === 'decision') reason = '需要具体决策或授权';
  else if (task.status === 'blocked' && ['invalid', 'expired', 'limit'].includes(task.wait?.status))
    reason = { invalid: '等待配置无效', expired: '等待时段已过期', limit: '自动唤醒预算已用完' }[task.wait.status];
  else if (task.status === 'blocked' && !task.wait) reason = '阻塞未设置可触发的恢复条件';
  if (!reason) return null;
  return { owner: '本地负责人', reason,
    action: '核对剩余阶段和有效约束，补充本轮要求后继续，或修正恢复条件；不会自动扩大权限或重做已完成步骤。' };
}
