/**
 * Read-only decision inputs of one task (ops command `explain`, refactor B2) and the effective follow-up values the
 * runtime uses. Every limit here is read from the current settings at call time; values a task cached at its last
 * assessment are reported separately and labelled as such (3.4: the snapshot showed a cached autoRoundLimit 200
 * while behaviour used settings.followup.maxAutoRounds 6).
 */
import { TASK_STATES, terminal } from './states.js';
import { automaticBlock, setHold } from './hold.js';
import { focusDecision } from './focus.js';
import { currentTask, keyTaken } from './workflow.js';
import { globalLimit, startLimit, projectLimit, hasSlot } from './dispatcher.js';

const DEFAULT_FRESH_CONTEXT_TOKENS = 200000;

/** The follow-up policy in force for a task now, with the runtime's defaults applied. */
export function effectiveFollowup(task, state) {
  const project = state.settings?.projects?.find(p => p.id === task.projectId);
  const f = project?.followup || {};
  return {
    enabled: Boolean(f.enabled),
    maxAutoRounds: f.maxAutoRounds || 40,
    minStagesPerRound: f.minStagesPerRound ?? null,
    maxWakeups: f.maxWakeups || 8,
    maxAudits: f.maxAudits ?? 3,
    reviewComments: Boolean(f.reviewComments),
    trustReceiverComments: Boolean(f.trustReceiverComments),
    freshRescue: Boolean(f.freshRescue),
    maxSessionRounds: f.maxSessionRounds ?? null,
    freshContextTokens: f.freshContextTokens ?? DEFAULT_FRESH_CONTEXT_TOKENS,
    dataVersionFile: f.dataVersionFile ?? null,
    observeAfterExpiry: Boolean(f.observeAfterExpiry),
  };
}

const future = (at, now) => Boolean(at) && now < Date.parse(at);

/** Why the task would or would not start on the next tick (queued tasks), or what could move it (others). */
function runnability(task, state, now) {
  const reasons = [];
  if (!currentTask(task, state)) reasons.push('historical: superseded by a newer task of the same issue');
  if (task.owner === 'human') reasons.push('manually owned (takeover); return ownership first');
  const hold = automaticBlock(task, state, 'start');
  if (hold) reasons.push(hold.reason);
  if (state.paused) reasons.push('dispatch is paused');
  if (task.status !== 'queued') {
    const entry = TASK_STATES[task.status];
    const next = !entry ? 'undeclared status' : entry.executing ? 'executing; reconciled every cycle'
      : terminal.has(task.status) ? 'settled; starts again only through a continuation, retry, comment/data/condition wake' : '';
    return { runnableNow: false, reasons: [`status ${task.status} is not queued (${next})`, ...reasons] };
  }
  if (future(task.resumeWindow?.notBefore, now)) reasons.push(`queue window opens at ${task.resumeWindow.notBefore} (clear-resume clears it)`);
  if (task.resumeWindow?.expiresAt && now >= Date.parse(task.resumeWindow.expiresAt)) reasons.push(`queue window expired at ${task.resumeWindow.expiresAt}; the next tick settles it as blocked`);
  if (task.admissionRetryAt && now < task.admissionRetryAt) reasons.push(`admission check failed; retried after ${new Date(task.admissionRetryAt).toISOString()}${task.admissionError ? ` (${task.admissionError})` : ''}`);
  if (state.tasks.some(o => o.owner === 'human' && !o.manualParked && o.cwd === task.cwd && o.id !== task.id)) reasons.push('a manual session owns the same directory');
  const occupied = state.tasks.filter(t => !terminal.has(t.status) && t.owner !== 'human' && t.status !== 'queued');
  if (occupied.length >= globalLimit(state)) reasons.push(`global concurrency full (${occupied.length}/${globalLimit(state)})`);
  else if (!hasSlot(task, occupied, state)) reasons.push(`project slot or shared directory busy (project limit ${projectLimit(task, state)})`);
  const ahead = state.tasks.filter(t => t.status === 'queued' && t.owner !== 'human').findIndex(t => t.id === task.id);
  return { runnableNow: reasons.length === 0, reasons, queuePosition: ahead >= 0 ? ahead + 1 : null,
    note: 'Linear admission (assignee/state) is rechecked right before start and is not evaluated here.' };
}

export function explainTask(task, state, { now = Date.now(), archived = false, adapters = {} } = {}) {
  const followup = effectiveFollowup(task, state);
  const [source] = (() => { try { return JSON.parse(task.key); } catch { return []; } })();
  const continuation = source ? keyTaken(state, JSON.stringify([source, `continue:${task.id}`])) : null;
  const attempt = task.attempts?.at(-1);
  return {
    id: task.id, issue: task.issue?.identifier || null, title: task.title, status: task.status, owner: task.owner,
    statusProperties: TASK_STATES[task.status] || null, archived, current: currentTask(task, state),
    evaluatedAt: new Date(now).toISOString(),
    settings: {
      paused: Boolean(state.paused), drain: state.drain?.on ? state.drain : { on: false },
      concurrency: globalLimit(state), startConcurrency: startLimit(state), projectMaxConcurrent: projectLimit(task, state),
      followup, source: 'current settings (revision ' + state.revision + ')',
    },
    counters: {
      autoRounds: { value: task.autoRounds || 0, limit: followup.maxAutoRounds },
      idleRounds: { value: task.continuationIdleRounds || 0, limit: 3, rule: 'three continuations without a new checkpoint stop the chain' },
      wakeups: { value: task.wakeups || 0, limit: followup.maxWakeups },
      reviewWakeups: { value: task.reviewWakeups || 0, limit: followup.maxWakeups },
      reviewAudits: { value: task.reviewAudits || 0, limit: followup.maxAudits },
      sessionRounds: { value: task.sessionRounds || 0, limit: followup.maxSessionRounds },
      recoveryStreak: task.recoveryStreak || 0, formatRepair: Boolean(task.formatRepair), freshRescued: Boolean(task.freshRescued),
      continuationStop: task.continuationStop || null, outputLimitRetried: Boolean(task.outputLimitRetried),
    },
    lastEvaluated: { autoRoundLimit: task.autoRoundLimit ?? null, note: 'copied onto the task at its last assessment; behaviour uses settings above' },
    holds: { hold: task.hold || null, pendingStop: task.pendingStop || null, manualParked: Boolean(task.manualParked) },
    focus: { enabled: Boolean(state.focus?.enabled), revision: state.focus?.revision ?? 0, issues: state.focus?.issues || [],
      decision: focusDecision(task, state), heldByFocus: task.hold?.by === 'focus',
      events: (task.events || []).filter(e => String(e.action).startsWith('focus-')).slice(-10) },
    pending: {
      wait: task.wait ? { kind: task.wait.kind, status: task.wait.status, notBefore: task.wait.notBefore, recheckAt: task.wait.recheckAt,
        expiresAt: task.wait.expiresAt, notBeforeInFuture: future(task.wait.notBefore, now), errorCount: task.wait.errorCount || 0 } : null,
      resumeWindow: task.resumeWindow || null, resumeWindowInFuture: future(task.resumeWindow?.notBefore, now),
      admissionRetryAt: task.admissionRetryAt ? new Date(task.admissionRetryAt).toISOString() : null,
      pendingComments: task.pendingComments?.length || 0, pendingRounds: task.pendingRounds?.length || 0,
      continuationTask: continuation || null,
      supersededBy: task.supersededBy || null,
    },
    attempt: attempt ? { id: attempt.id, executor: attempt.executor, status: attempt.status, sessionId: attempt.sessionId,
      adapterLoaded: Boolean(adapters[attempt.executor]) } : null,
    runnable: runnability(task, state, now),
    recentEvents: (task.events || []).slice(-10),
  };
}

/**
 * Upgrade: a current, scheduler-owned stopped task whose latest stop/return event is a stop was stopped by a user
 * before holds existed. It gets the hold now (otherwise the next owner comment would resume it as before).
 */
export function migrateUserStops(state) {
  let count = 0;
  for (const task of state.tasks) {
    if (task.hold || task.status !== 'stopped' || task.owner === 'human' || !currentTask(task, state)) continue;
    const last = (task.events || []).findLast(e => e.action === 'stop' || e.action === 'return');
    if (last?.action !== 'stop') continue;
    setHold(task, { reason: 'stop (before holds existed)', at: last.at });
    task.events.push({ action: 'hold-migrated', at: new Date().toISOString() });
    count++;
  }
  return count;
}
