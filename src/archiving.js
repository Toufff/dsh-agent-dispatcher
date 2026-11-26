import { terminal, has } from './states.js';
import { currentTask, issueKey } from './workflow.js';

/**
 * What leaves the hot state. Archived data stays readable by id (src/archive.js) and every place that needs
 * history reads it back on demand, so the dispatcher behaves exactly as if it were still in memory.
 *
 * A task is archived when nothing automatic can read it again:
 * - it is terminal, scheduler-owned, not stopping, has no pending Linear write-back or unpublished rounds, and
 *   no task that stays hot points at it through a wait (taskId / resolvedFromTaskId);
 * - and it was superseded by a continuation, or it ended more than `taskDays` ago and is either historical
 *   (not the current task of its issue) or a current task that no automatic path wakes again: accepted or
 *   stopped, without a held review-comment notice. Review, blocked, decision, stalled, needs_result, failed and
 *   exhausted tasks stay hot whatever their age: comments, data versions, waits, notifications and retries
 *   still act on them.
 * - A current task leaves only together with every other task of its issue, so "current" never moves to an
 *   older task.
 * Every task that stays keeps only its latest `keepRounds` automatic-round results; older rounds move out.
 * Finished outbox items (sent / superseded) move out `outboxDays` after they finished; their ids stay known as
 * this host's own Linear comments.
 */
export const archiveDefaults = { taskDays: 3, keepRounds: 3, outboxDays: 1 };
const DAY = 864e5;

export function archivePolicy(settings) { return { ...archiveDefaults, ...(settings?.archive || {}) }; }
const endedAt = task => Date.parse(task.events?.at(-1)?.at || task.createdAt || 0);

export function archivePlan(state, policy = archivePolicy(state.settings), now = Date.now(), { unstampedOutbox = 'stamp' } = {}) {
  const pendingReports = new Set(state.outbox.filter(i => i.status === 'pending').map(i => i.taskId));
  const candidates = new Set(state.tasks.filter(task => {
    if (!terminal.has(task.status) || task.owner === 'human' || task.pendingStop || pendingReports.has(task.id) || task.pendingRounds?.length || task.pendingComments?.length) return false;
    if (task.supersededBy) return true;
    if (now - endedAt(task) < policy.taskDays * DAY) return false;
    return !currentTask(task, state) || (has(task.status, 'closed') && !task.reviewLimitNotified);
  }).map(t => t.id));
  // Remove what a staying task still references, until nothing changes.
  for (let changed = true; changed;) {
    changed = false;
    const staying = state.tasks.filter(t => !candidates.has(t.id));
    const referenced = new Set(staying.flatMap(t => [t.wait?.taskId, t.wait?.resolvedFromTaskId].filter(Boolean)));
    const stayingIssues = new Set(staying.map(t => issueKey(t, state)).filter(Boolean));
    for (const id of candidates) {
      const task = state.tasks.find(t => t.id === id);
      const key = issueKey(task, state);
      if (referenced.has(id) || (!task.supersededBy && key && currentTask(task, state) && stayingIssues.has(key))) { candidates.delete(id); changed = true; }
    }
  }
  const tasks = state.tasks.filter(t => candidates.has(t.id));
  const rounds = state.tasks.filter(t => !candidates.has(t.id) && (t.rounds?.length || 0) > policy.keepRounds)
    .map(t => ({ task: t, count: t.rounds.length - policy.keepRounds }));
  const stamp = [], outbox = [];
  for (const item of state.outbox) {
    if (!['sent', 'superseded'].includes(item.status)) continue;
    if (!item.finishedAt) (unstampedOutbox === 'archive' ? outbox : stamp).push(item);
    else if (now - Date.parse(item.finishedAt) >= policy.outboxDays * DAY) outbox.push(item);
  }
  return { tasks, rounds, outbox, stamp };
}

/**
 * Move the planned history to the archive, then drop it from `state` (mutated in place). Archive writes are
 * durable before the state changes; repeating a pass after a crash only repeats appends.
 */
export async function applyArchive(state, archive, plan, now = Date.now()) {
  const at = new Date(now).toISOString();
  for (const item of plan.stamp) item.finishedAt = at;
  if (!plan.tasks.length && !plan.rounds.length && !plan.outbox.length) return plan;
  for (const { task, count } of plan.rounds) await archive.archiveRounds(task.id, task.archivedRounds || 0, task.rounds.slice(0, count));
  const prev = new Map(state.tasks.map((t, i) => [t.id, i ? state.tasks[i - 1].id : null]));
  await archive.archiveTasks(plan.tasks, at, prev);
  await archive.archiveOutbox(plan.outbox, at);
  for (const { task, count } of plan.rounds) {
    task.rounds = task.rounds.slice(count);
    task.archivedRounds = (task.archivedRounds || 0) + count;
  }
  const gone = new Set(plan.tasks.map(t => t.id)), sent = new Set(plan.outbox.map(i => i.id));
  state.tasks = state.tasks.filter(t => !gone.has(t.id));
  state.outbox = state.outbox.filter(i => !sent.has(i.id));
  return plan;
}

/** Put an archived task back into the hot state (for a command that acts on it), in creation order. */
export function restoreTask(state, archive, id) {
  if (state.tasks.some(t => t.id === id) || !archive?.has('tasks', id)) return false;
  const task = archive.task(id);
  const index = state.tasks.findIndex(t => Date.parse(t.createdAt || 0) > Date.parse(task.createdAt || 0));
  state.tasks.splice(index < 0 ? state.tasks.length : index, 0, task);
  return true;
}
