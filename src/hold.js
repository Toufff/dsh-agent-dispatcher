/**
 * Stop that sticks (refactor 3.5) and drain (B6).
 *
 * A user stop used to be an event: the task became 'stopped' and every automatic path re-derived on the next 1.5 s
 * cycle whether it should run again. Several did (see docs/architecture.md "User hold"). Now a user stop also
 * persists `task.hold = { by: 'user', reason, at }`, and every path that would start, requeue, continue or wake a
 * task asks `automaticBlock()` right before acting. Only an explicit owner action (retry, continue, submit,
 * arm-wait, unhold) clears it.
 *
 * Drain is the global counterpart: `state.drain = { on: true, ... }` lets running turns finish but starts nothing
 * new (tick, intake, wakes, comment/data continuations, output-limit retries), so the host can be restarted once
 * nothing is executing.
 */
import { TASK_STATES } from './states.js';
import { focusBlock } from './focus.js';

export const HOLD_ERROR = 'TASK_HELD';
export const DRAIN_ERROR = 'DISPATCH_DRAINING';
/** Marks a command() call made by the runtime itself (comment/data wakes). Not reachable from the JSON RPC. */
export const AUTOMATIC = Symbol('automatic dispatcher command');

// Paths drain stops. 'requeue' (assess moving a finished round back to queued) is not one: the round stays queued,
// durable, and starts after undrain or a restart.
const DRAINED = new Set(['start', 'intake', 'wake', 'comment', 'data', 'output-retry', 'continue']);

/**
 * Why automatic work on `path` must not act on this task now, or null. path: start | requeue | continue | wake |
 * comment | data | output-retry | intake | interrupted-resume. Focus mode gates only 'start' (src/focus.js).
 */
export function automaticBlock(task, state, path) {
  // A focus hold (by: 'focus') is not a user stop: focus mode decides it afresh (focusBlock) on every start.
  if (task?.hold && task.hold.by !== 'focus') return { code: HOLD_ERROR, path, reason: `用户已停止并冻结（${task.hold.reason || '无说明'}），需显式重试、继续或解除冻结` };
  if (state?.drain?.on && DRAINED.has(path)) return { code: DRAIN_ERROR, path, reason: '派发器正在排空（drain），不启动新执行' };
  return task ? focusBlock(task, state, path) : null;
}
export function blockError(block) { return Object.assign(new Error(block.reason), { code: block.code }); }

export function setHold(task, { reason = 'stop', at = new Date().toISOString() } = {}) {
  task.hold = { by: 'user', reason: String(reason).slice(0, 300), at };
}
/** Clears a hold on an explicit owner action; records who cleared it. Returns whether there was one. */
export function clearHold(task, action, at = new Date().toISOString()) {
  if (!task?.hold) return false;
  (task.events ||= []).push({ action: 'unhold', by: action, hold: task.hold, at });
  delete task.hold;
  return true;
}

/** Restart readiness: what a host restart would interrupt right now. */
export function restartReadiness(state) {
  const executing = state.tasks.filter(t => TASK_STATES[t.status]?.executing);
  const ref = t => ({ id: t.id, issue: t.issue?.identifier, status: t.status });
  const certain = executing.filter(t => !TASK_STATES[t.status].uncertain);
  return {
    // No executor turn may be live: a restart interrupts nothing.
    idleForRestart: executing.length === 0,
    // Only tasks in 'unknown' remain: a restart cannot interrupt a confirmed live turn.
    idleExceptUncertain: certain.length === 0,
    executing: certain.map(ref),
    uncertain: executing.filter(t => TASK_STATES[t.status].uncertain).map(ref),
    queued: state.tasks.filter(t => t.status === 'queued').length,
  };
}
