/**
 * Declarative task status table (refactor B1). Every value a task's `status` can take is declared here once, with
 * the properties the kernel, runtime, notifications and UI branch on. Code asks the table (`is(status, 'terminal')`,
 * `statusesWith('retryable')`) instead of keeping its own literal list: a status missing from one of those lists
 * (2026-11-26: 'manual' was not terminal, so 14 human-owned tasks blocked every configure) can no longer happen
 * silently, and test/states.test.js fails when a status is assigned anywhere in src/ without an entry here.
 *
 * Pure data, no imports: the UI bundle imports it too.
 *
 * Properties (false when omitted):
 * - terminal: settled; no execution slot, not reconciled, does not count as active for configure / intake guards.
 * - holdsSlot: owns one automatic execution slot (every non-terminal status except queued).
 * - executing: an executor turn may be live; a host restart would interrupt it (drain / idle-for-restart).
 * - uncertain: execution state not confirmed (kept out of idle-for-restart only with `strict`).
 * - afterRestart: what a host restart does: 'requeue' (picked again by tick), 'reconcile' (asks the adapter about
 *   its recorded attempt; may come back as interrupted and be resumed in the same session), 'settled' (nothing).
 * - continuable: an explicit owner continuation (command continue) may follow it.
 * - offersContinue: the panel offers the continuation form (stopped tasks are retried instead).
 * - retryable: command retry accepts it.
 * - armable: the owner may set a resume condition (arm-wait); the wait panel describes it.
 * - commentResumable: a settled round a trusted owner comment continues (reviewComments).
 * - commentResumeNote: the comment prompt says the round had stalled / been stopped.
 * - dataWake: a data-version change may wake it (when it waits for data).
 * - linearReview: reported with the mapping's review state; a dependency counts it as completed.
 * - dependencyFails: a task wait on it fails instead of waiting.
 * - notify: raises its own Feishu notification type.
 * - closed: finished for good from the scheduler's view (no decision notice; archived once old).
 * - executionReport: Linear start/failure report: 'now', or 'delayed' (after 60 s without change).
 * - executionNotice: entering it marks an execution notice.
 * - panelGroup: the panel filter it belongs to ('active' | 'attention' | 'review').
 */
export const TASK_STATES = Object.freeze({
  queued: { afterRestart: 'requeue', panelGroup: 'active' },
  starting: { holdsSlot: true, executing: true, afterRestart: 'reconcile', panelGroup: 'active' },
  running: { holdsSlot: true, executing: true, afterRestart: 'reconcile', executionReport: 'now', executionNotice: true, panelGroup: 'active' },
  finishing: { holdsSlot: true, executing: true, afterRestart: 'reconcile', panelGroup: 'active' },
  waiting: { holdsSlot: true, executing: true, afterRestart: 'reconcile', panelGroup: 'active' },
  busy: { holdsSlot: true, executing: true, afterRestart: 'reconcile', panelGroup: 'active' },
  stopping: { holdsSlot: true, executing: true, afterRestart: 'reconcile', panelGroup: 'active' },
  unknown: { holdsSlot: true, executing: true, uncertain: true, afterRestart: 'reconcile', executionReport: 'delayed', executionNotice: true, panelGroup: 'attention' },
  review: { terminal: true, afterRestart: 'settled', continuable: true, offersContinue: true, commentResumable: true, linearReview: true, panelGroup: 'review' },
  accepted: { terminal: true, afterRestart: 'settled', continuable: true, offersContinue: true, linearReview: true, closed: true },
  blocked: { terminal: true, afterRestart: 'settled', continuable: true, offersContinue: true, armable: true, commentResumable: true, dataWake: true, panelGroup: 'attention' },
  decision: { terminal: true, afterRestart: 'settled', continuable: true, offersContinue: true, armable: true, commentResumable: true, dataWake: true, dependencyFails: true, notify: true, panelGroup: 'attention' },
  stalled: { terminal: true, afterRestart: 'settled', continuable: true, offersContinue: true, armable: true, commentResumable: true, commentResumeNote: true, dependencyFails: true, notify: true, panelGroup: 'attention' },
  needs_result: { terminal: true, afterRestart: 'settled', continuable: true, offersContinue: true, commentResumable: true, dataWake: true, dependencyFails: true, notify: true, panelGroup: 'attention' },
  stopped: { terminal: true, afterRestart: 'settled', continuable: true, retryable: true, armable: true, commentResumable: true, commentResumeNote: true, dependencyFails: true, closed: true },
  failed: { terminal: true, afterRestart: 'settled', retryable: true, dependencyFails: true, notify: true, executionReport: 'now', executionNotice: true, panelGroup: 'attention' },
  exhausted: { terminal: true, afterRestart: 'settled', retryable: true, dependencyFails: true, notify: true, executionReport: 'now', panelGroup: 'attention' },
  // Human takeover. Terminal for the scheduler (no slot, not reconciled, not active for configure); ownership
  // (task.owner === 'human') is what keeps the directory exclusive.
  manual: { terminal: true, afterRestart: 'settled' },
});

export const TASK_STATUSES = Object.freeze(Object.keys(TASK_STATES));

/** Whether a task status has a property. An undeclared status throws: it is a bug, not a silent false. */
export function is(status, property) {
  const entry = TASK_STATES[status];
  if (!entry) throw new Error(`Undeclared task status: ${status}`);
  return Boolean(entry[property]);
}
/** Like is(), but an undeclared or missing status is false (for display code reading foreign records). */
export function has(status, property) { return Boolean(TASK_STATES[status]?.[property]); }
export function statusesWith(property) { return TASK_STATUSES.filter(s => TASK_STATES[s][property]); }
export const terminal = new Set(statusesWith('terminal'));
export const property = (status, name) => TASK_STATES[status]?.[name];

/** Attempt statuses after which the recorded session is confirmed finished and can be resumed. */
export const RESUMABLE_ATTEMPT = new Set(['review', 'stopped']);
/** Adapter results that confirm a pending stop / takeover finished the turn. */
export const STOP_CONFIRMING_RESULTS = new Set(['review', 'failed', 'stopped', 'needs_input']);
/** Adapter results the kernel adopts as the task and attempt status unchanged. */
export const ADOPTED_RESULTS = new Set(['running', 'finishing', 'waiting', 'review', 'failed']);
/** Wait statuses monitor() still owns (a live wait). */
export const LIVE_WAIT = new Set(['watching', 'validating', 'expired']);
/** Wait statuses that are being watched (not expired). */
export const WATCHED_WAIT = new Set(['watching', 'validating']);
/** Wait statuses that ended with a fault the owner must correct. */
export const FAULTED_WAIT = new Set(['invalid', 'expired', 'limit']);
