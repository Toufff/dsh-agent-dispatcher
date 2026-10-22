import { z } from 'zod';

const timestamp = z.string().datetime({ offset: true });
export const waitSchema = z.object({
  kind: z.enum(['linear', 'time']),
  condition: z.string().trim().min(1).max(2000),
  issueId: z.string().min(1).max(160).optional(),
  notBefore: timestamp.optional(),
  expiresAt: timestamp.optional()
}).strict().superRefine((wait, ctx) => {
  if (wait.kind === 'time' && !wait.notBefore)
    ctx.addIssue({ code: 'custom', message: 'Time waits require an exact timestamp with timezone' });
  if (wait.expiresAt && (!wait.notBefore || Date.parse(wait.expiresAt) <= Date.parse(wait.notBefore)))
    ctx.addIssue({ code: 'custom', message: 'Window end must follow an explicit start' });
});

export function wakeEvent(wait, activity, policy, now, ownCommentIds = []) {
  if (wait.expiresAt && now >= Date.parse(wait.expiresAt)) return { expired: true };
  if (wait.notBefore && now < Date.parse(wait.notBefore)) return null;
  if (wait.kind === 'time') return { key: `time:${wait.id}`, reason: `Scheduled check reached ${wait.notBefore}` };
  if (!activity || ['completed', 'canceled'].includes(activity.parentState?.type)) return null;
  const comments = activity.comments.filter(c =>
    policy.commentAuthorIds.includes(c.user?.id) && c.user?.id !== policy.assigneeId &&
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
