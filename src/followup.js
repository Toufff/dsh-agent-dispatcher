import { z } from 'zod';
import { waitScopeError } from './workflow.js';

const timestamp = z.string().datetime({ offset: true });
export const waitSchema = z.object({
  kind: z.enum(['linear', 'time', 'task']),
  condition: z.string().trim().min(1).max(2000),
  workItemIds: z.array(z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/)).min(1).max(40).optional(),
  issueId: z.string().min(1).max(160).optional(),
  taskId: z.string().min(1).max(160).optional(),
  expectedAuthorIds: z.array(z.string().min(1).max(160)).min(1).max(30).optional(),
  notBefore: timestamp.optional(),
  recheckAt: timestamp.optional(),
  expiresAt: timestamp.optional()
}).strict().superRefine((wait, ctx) => {
  if (wait.kind === 'linear' && !wait.expectedAuthorIds)
    ctx.addIssue({ code: 'custom', path: ['expectedAuthorIds'], message: 'Declare the required Linear reply authors explicitly' });
  if (wait.kind === 'task' && !wait.taskId && !wait.issueId)
    ctx.addIssue({ code: 'custom', message: 'Task waits require a local task ID or its issue ID' });
  if (wait.kind !== 'task' && wait.taskId || wait.kind !== 'linear' && wait.expectedAuthorIds)
    ctx.addIssue({ code: 'custom', message: 'Dependency and reply fields must match the wait kind' });
  if (wait.kind === 'time' && !wait.notBefore)
    ctx.addIssue({ code: 'custom', message: 'Time waits require an exact timestamp with timezone' });
  if (wait.recheckAt && wait.kind !== 'linear')
    ctx.addIssue({ code: 'custom', message: 'Independent rechecks are only supported for Linear waits' });
  if (wait.recheckAt && ((wait.notBefore && Date.parse(wait.recheckAt) < Date.parse(wait.notBefore)) ||
      (wait.expiresAt && Date.parse(wait.recheckAt) >= Date.parse(wait.expiresAt))))
    ctx.addIssue({ code: 'custom', message: 'Recheck must be within the permitted monitoring window' });
  if (wait.expiresAt && wait.notBefore && Date.parse(wait.expiresAt) <= Date.parse(wait.notBefore))
    ctx.addIssue({ code: 'custom', message: 'Window end must follow its start' });
});

export const waitFaults = {
  WAIT_SCOPE_INVALID: '独立等待必须绑定未受审批影响的未完成阶段，且其依赖已完成；不能用定时唤醒替代审批。',
  WAIT_REPLY_UNDECLARED: '旧等待没有明确回复人，无法证明条件能被触发。请本地负责人确认结果由谁产生，并改为明确回复人、任务依赖或人工决策；不会猜测并继续监听。',
  WAIT_DEPENDENCY_PENDING: '依赖完成回执已改变，需重新核验并设置等待条件。',
  WAIT_CONFIGURATION_CHANGED: '本地执行约束或项目配置已改变，需要核对并重新保存等待条件；反复检查不会解决。',
  WAIT_REPLY_UNREACHABLE: '要求的回复人不能通过本地信任规则。若等待本方任务结果，请使用 task 依赖，不要等待本方评论或扩大信任名单。',
  WAIT_DEPENDENCY_INVALID: '依赖必须唯一指向同一本地项目的已有任务；不能依赖自身、被替代任务或跨项目任务。',
  WAIT_DEPENDENCY_CYCLE: '检测到循环任务依赖，没有任务能够先推进。请修正任务分工和依赖方向。',
  WAIT_DEPENDENCY_STOPPED: '依赖任务已失败、停止、需人工决策或失去自动控制，不能当作完成。请先处理依赖任务。'
};
export function waitFault(code) { return Object.assign(new Error(waitFaults[code]), { code }); }

// Resolve only kernel-recorded continuation edges, never infer a replacement by date.
function continuationTarget(target, state) {
  const seen = new Set();
  while (target) {
    if (seen.has(target.id)) throw waitFault('WAIT_DEPENDENCY_CYCLE');
    seen.add(target.id);
    const [source] = JSON.parse(target.key);
    const children = state.tasks.filter(t => t.continuationOf === target.id ||
      t.key === JSON.stringify([source, `continue:${target.id}`]) || t.id === target.supersededBy);
    if (!children.length) {
      if (target.supersededBy) throw waitFault('WAIT_DEPENDENCY_INVALID');
      return target;
    }
    const next = children[0];
    if (children.length !== 1 || next.continuationOf !== target.id || target.supersededBy !== next.id ||
        next.key !== JSON.stringify([source, `continue:${target.id}`]) || next.projectId !== target.projectId ||
        next.issue?.id !== target.issue?.id) throw waitFault('WAIT_DEPENDENCY_INVALID');
    target = next;
  }
}

// New waits may resolve a stale reference through verified lineage. Saved waits stay pinned.
export function validateLocalWait(wait, task, state) {
  if (waitScopeError(wait, task.workItems, task.status === 'decision')) throw waitFault('WAIT_SCOPE_INVALID');
  const project = state.settings.projects.find(p => p.id === task.projectId);
  if (wait.kind === 'linear') {
    if (!wait.expectedAuthorIds?.length) throw waitFault('WAIT_REPLY_UNDECLARED');
    const allowed = (project?.followup?.commentAuthorIds || []).filter(id => id !== project?.linear?.assigneeId);
    if (!allowed.length || wait.expectedAuthorIds?.some(id => !allowed.includes(id))) throw waitFault('WAIT_REPLY_UNREACHABLE');
  }
  if (wait.kind !== 'task') return wait;
  const matches = state.tasks.filter(t => t.projectId === task.projectId &&
    (wait.taskId ? t.id === wait.taskId : t.issue?.id === wait.issueId || t.issue?.identifier === wait.issueId));
  const targets = [...new Map(matches.map(t => {
    const resolved = continuationTarget(t, state);
    if (wait.id && resolved.id !== t.id) throw waitFault('WAIT_DEPENDENCY_INVALID');
    return [resolved.id, resolved];
  })).values()];
  const target = targets[0];
  if (targets.length !== 1 || target.id === task.id || wait.taskId && wait.issueId &&
      ![target.issue?.id, target.issue?.identifier].includes(wait.issueId)) throw waitFault('WAIT_DEPENDENCY_INVALID');
  const [source] = JSON.parse(target.key);
  if (state.tasks.some(t => t.key === JSON.stringify([source, `continue:${target.id}`]))) throw waitFault('WAIT_DEPENDENCY_INVALID');
  const seen = new Set([task.id]);
  let cursor = target;
  while (cursor) {
    if (seen.has(cursor.id)) throw waitFault('WAIT_DEPENDENCY_CYCLE');
    seen.add(cursor.id);
    cursor = cursor.status === 'blocked' && cursor.wait?.kind === 'task'
      ? state.tasks.find(t => t.id === cursor.wait.taskId) : null;
  }
  return { ...wait, taskId: target.id, issueId: target.issue?.id,
    ...(wait.taskId && wait.taskId !== target.id ? { resolvedFromTaskId: wait.taskId } : {}) };
}

export function dependencyEvent(wait, task, state, now) {
  validateLocalWait(wait, task, state);
  if (wait.expiresAt && now >= Date.parse(wait.expiresAt)) return { expired: true };
  if (wait.notBefore && now < Date.parse(wait.notBefore)) return null;
  const target = state.tasks.find(t => t.id === wait.taskId);
  if (target.owner === 'human' || ['failed', 'stopped', 'exhausted', 'decision', 'stalled', 'needs_result'].includes(target.status) ||
      ['invalid', 'expired', 'limit'].includes(target.wait?.status) && target.status === 'blocked') throw waitFault('WAIT_DEPENDENCY_STOPPED');
  const attempt = target.attempts?.at(-1);
  if (!['review', 'accepted'].includes(target.status) || !target.assessed || target.outcome?.status !== 'complete' ||
      !attempt?.accepted || attempt.status !== 'review') return null;
  return { key: `task:${wait.id}:${target.id}:${attempt.id}`, reason: JSON.stringify({
    taskId: target.id, issue: target.issue?.identifier, status: target.status,
    result: target.outcome, note: 'Local completion receipt, not human acceptance or production authorization.'
  }) };
}

export function wakeEvent(wait, activity, policy, now, ownCommentIds = []) {
  if (wait.expiresAt && now >= Date.parse(wait.expiresAt)) return { expired: true };
  if (wait.notBefore && now < Date.parse(wait.notBefore)) return null;
  if (wait.kind === 'time') return { key: `time:${wait.id}`, reason: `Scheduled check reached ${wait.notBefore}` };
  if (wait.kind === 'linear' && wait.recheckAt && now >= Date.parse(wait.recheckAt))
    return { key: `recheck:${wait.id}`, reason: `Independent recheck reached ${wait.recheckAt}. No peer receipt is implied. Read current evidence and verify all remaining conditions; this timer is NOT authorization.` };
  if (!activity || ['completed', 'canceled'].includes(activity.parentState?.type)) return null;
  const comments = activity.comments.filter(c =>
    policy.commentAuthorIds.includes(c.user?.id) && c.user?.id !== policy.assigneeId &&
    (!wait.expectedAuthorIds || wait.expectedAuthorIds.includes(c.user?.id)) &&
    !ownCommentIds.includes(c.id) && Date.parse(c.updatedAt) > Date.parse(wait.armedAt) &&
    !(wait.seen || []).includes(`${c.id}:${c.updatedAt}`));
  if (!comments.length) return null;
  // Batch all changes in one wake; comments are evidence, never execution permission.
  return { key: comments.map(c => `${c.id}:${c.updatedAt}`).sort().join('|'),
    seen: comments.map(c => `${c.id}:${c.updatedAt}`),
    reason: JSON.stringify({ issue: activity.identifier, state: activity.state, comments: comments.map(c => ({
      id: c.id, authorId: c.user.id, updatedAt: c.updatedAt, body: c.body.slice(0, 8000)
    })) }).slice(0, 24000) };
}
