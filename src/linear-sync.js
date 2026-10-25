import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { WaitTargetError, validWaitTarget } from './linear.js';
import { currentTask } from './workflow.js';

const overlap = 60000, reconcileEvery = 15 * 60000;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function syncGroups(state) {
  const groups = new Map();
  for (const project of state.settings.projects.filter(p => p.linear?.enabled)) {
    const key = JSON.stringify([project.linear.workspaceId, project.linear.tokenEnv]);
    if (!groups.has(key)) groups.set(key, { key, projects: [], waits: [] });
    const group = groups.get(key); group.projects.push(project);
    if (!state.paused && project.followup?.enabled) for (const task of state.tasks) {
      if (!currentTask(task, state) || task.projectId !== project.id || task.status !== 'blocked' || task.owner === 'human' || !task.issue?.id ||
          !['watching', 'validating', 'expired'].includes(task.wait?.status)) continue;
      if (task.wait.kind === 'task' || task.wait.kind !== 'linear' && task.wait.status !== 'expired') continue;
      if (task.wait.status === 'expired' && !project.followup.observeAfterExpiry) continue;
      if (state.tasks.some(t => t.owner === 'human' && t.cwd === task.cwd)) continue;
      const [source] = JSON.parse(task.key);
      if (state.tasks.some(t => t.key === JSON.stringify([source, `continue:${task.id}`]))) continue;
      group.waits.push(task);
    }
  }
  for (const group of groups.values()) group.signature = hash([group.projects, group.waits.map(t => [t.id, t.wait.id])]);
  return [...groups.values()];
}

function activityFor(task, project, watched, comments) {
  const parent = watched.find(i => i.id === task.issue.id), target = watched.find(i => i.id === (task.wait.issueId || task.issue.id));
  if (!parent || parent.archivedAt || parent.project?.id !== project.linear.projectId || parent.assignee?.id !== project.linear.assigneeId || ['completed', 'canceled'].includes(parent.state?.type))
    throw new Error('Parent issue is closed, reassigned or outside the mapped project; local continuation remains stopped');
  if (!validWaitTarget(parent, target, project.linear.projectId)) throw new WaitTargetError();
  return { ...target, parentState: parent.state, comments: comments.filter(c => c.issue?.id === target.id) };
}

/** One host-owned sync loop. Pages never own remote cursors or start another loop. */
export class LinearSync {
  constructor(runtime, { now = Date.now } = {}) { this.runtime = runtime; this.now = now; }
  run(options = {}) {
    if (this.inflight) return this.inflight;
    this.inflight = this.perform(options).finally(() => { this.inflight = null; });
    return this.inflight;
  }
  async perform({ force = false } = {}) {
    const r = this.runtime, state = await r.store.load(), groups = syncGroups(state);
    for (const group of groups) {
      const now = this.now(), saved = state.linearSync?.[group.key] || {};
      const same = saved.signature === group.signature;
      // Manual checks and configuration changes must not evade an active rate limit/backoff.
      if (saved.retryAt > now || (!force && same && saved.nextAt > now)) continue;
      const full = !same || !saved.reconciledAt || now - saved.reconciledAt >= reconcileEvery;
      const since = full || !saved.cursor ? undefined : new Date(Date.parse(saved.cursor) - overlap).toISOString();
      const commentStart = group.waits.length ? new Date(Math.min(...group.waits.map(t => Date.parse(t.wait.armedAt)))).toISOString() : new Date(now).toISOString();
      const valid = async () => syncGroups(await r.store.load()).some(g => g.key === group.key && g.signature === group.signature);
      let monitored = false;
      try {
        const result = await r.client(group.projects[0].linear).changes({
          workspaceId: group.projects[0].linear.workspaceId, mappings: group.projects.map(p => p.linear),
          targets: group.waits.map(t => ({ parentId: t.issue.id, issueId: t.wait.issueId || t.issue.id })),
          issueSince: since, commentSince: since && since > commentStart ? since : commentStart, startedAt: now
        });
        if (!await valid()) continue;
        const retained = same ? saved.comments || [] : [];
        const merged = new Map(retained.map(c => [c.id, c]));
        for (const c of result.comments) if (!merged.has(c.id) || c.updatedAt >= merged.get(c.id).updatedAt) merged.set(c.id, c);
        const comments = [...merged.values()].filter(c => c.updatedAt >= commentStart && group.waits.some(t => (t.wait.issueId || t.issue.id) === c.issue?.id));
        if (comments.length > 5000) throw new Error('待处理回复过多，请核对并缩小监听范围');
        const changed = result.issues.some(i => !saved.cursor || i.updatedAt > saved.cursor) || result.comments.some(c => !retained.some(old => old.id === c.id && old.updatedAt === c.updatedAt));
        // Save the inbox before delivering any events. A crash can replay intake, which is idempotent.
        await r.dispatcher.update(s => {
          if (!syncGroups(s).some(g => g.key === group.key && g.signature === group.signature)) return;
          s.linearSync ||= {}; s.linearSync[group.key] = { ...saved, signature: group.signature, comments, reconciledAt: same ? saved.reconciledAt || 0 : 0, nextAt: 0 };
          if (!same) delete s.linearSync[group.key].cursor;
        });
        let intakeError;
        try { await r.intake({ projects: group.projects, issues: result.issues }); }
        catch (error) { intakeError = error; }
        const activities = new Map();
        for (const task of group.waits) {
          const project = group.projects.find(p => p.id === task.projectId);
          try { if (result.activityError) throw result.activityError;
            activities.set(task.id, { waitId: task.wait.id, value: activityFor(task, project, result.watched, comments) }); }
          catch (error) { activities.set(task.id, { waitId: task.wait.id, error }); }
        }
        await r.monitor({ activities });
        monitored = true;
        if (intakeError || result.issueError || result.activityError) throw intakeError || result.issueError || result.activityError;
        const idle = changed ? 0 : (same ? saved.idle || 0 : 0) + 1;
        const intervalMs = group.waits.length ? Math.min(120000, 30000 * 2 ** Math.min(idle, 2)) : Math.min(300000, 60000 * 2 ** Math.min(idle, 3));
        await r.dispatcher.update(s => {
          // Configuration changes during delivery cannot advance a cursor for different mappings.
          if (!isDeepStrictEqual(group.projects, s.settings.projects.filter(p => group.projects.some(g => g.id === p.id)))) return;
          s.linearSync[group.key] = { signature: group.signature, comments, cursor: result.until, idle,
            lastAttemptAt: new Date(now).toISOString(), lastSuccessAt: new Date(this.now()).toISOString(),
            nextAt: this.now() + intervalMs, intervalMs, failures: 0,
            reconciledAt: full ? now : saved.reconciledAt };
        });
      } catch (error) {
        if (!await valid() && !monitored) continue;
        const failures = (saved.failures || 0) + 1;
        const delay = Math.max(error.retryAfterMs || 0, Math.min(900000, 30000 * 2 ** Math.min(failures - 1, 5)));
        await r.dispatcher.update(s => {
          if (!isDeepStrictEqual(group.projects, s.settings.projects.filter(p => group.projects.some(g => g.id === p.id)))) return;
          s.linearSync ||= {}; s.linearSync[group.key] = { ...(s.linearSync[group.key] || saved),
            lastAttemptAt: new Date(now).toISOString(), failures, retryAt: this.now() + delay, nextAt: this.now() + delay,
            error: error.code === 'RATE_LIMITED' ? 'Linear 请求限流，等待额度恢复' : 'Linear 同步失败，自动退避重试；同步进度已保留' };
        });
        if (!monitored) await r.monitor({ activities: new Map(group.waits.map(t => [t.id, { waitId: t.wait.id, error }])) });
      }
    }
  }
}
