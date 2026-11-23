import { randomUUID } from 'node:crypto';
import { captureResultText } from './result-text.js';
import { waitFaults } from './followup.js';
import { currentTask, issueKey, keyTaken, repairRound, deliverPendingComments } from './workflow.js';
import { asStateStore } from './state-store.js';

export const terminal = new Set(['review', 'failed', 'exhausted', 'stopped', 'accepted', 'blocked', 'decision', 'stalled', 'needs_result']);
async function bounded(operation, ms = 15000) {
  let timer;
  try { return await Promise.race([Promise.resolve().then(operation), new Promise(resolve => {
    timer = setTimeout(() => resolve({ status: 'unknown', reason: 'Operation timed out; reconcile before continuing' }), ms);
  })]); } finally { clearTimeout(timer); }
}

const slotGroup = task => task.projectId ? `project:${task.projectId}` : `cwd:${task.cwd}`;
export function globalLimit(state) { return Math.max(1, state.settings?.concurrency ?? 1); }
export function projectLimit(task, state) {
  return Math.max(1, (task.projectId && state.settings?.projects?.find(p => p.id === task.projectId)?.maxConcurrent) || 1);
}
/** A queued task may start when its project has a free slot and no other project is running in the same directory. */
export function hasSlot(task, occupied, state) {
  const group = slotGroup(task);
  if (occupied.some(o => o.cwd === task.cwd && slotGroup(o) !== group)) return false;
  return occupied.filter(o => slotGroup(o) === group).length < projectLimit(task, state);
}

/**
 * A single-owner kernel. Every section works on the store's draft inside one lock; a checkpoint commits the
 * draft (durable ones persist before the next external side effect) and a failed section rolls it back.
 */
export class Dispatcher {
  #tail = Promise.resolve();
  /** startContext(task, state): extra fields for adapter.start, computed in the lock (it may record on task). */
  constructor({ store, adapters, id = randomUUID, beforeStart, enabled, startContext }) {
    this.store = asStateStore(store);
    this.adapters = adapters;
    this.id = id;
    this.beforeStart = beforeStart;
    this.enabled = enabled;
    this.startContext = startContext;
  }

  #exclusive(fn) {
    const result = this.#tail.then(fn);
    this.#tail = result.catch(() => {});
    return result;
  }
  /** Runs fn on the draft; an exception discards the draft's uncommitted changes. Caller holds the lock. */
  async #within(fn) {
    const state = await this.store.begin();
    try { return await fn(state); }
    catch (error) { this.store.rollback(state); throw error; }
  }
  #section(fn) { return this.#exclusive(() => this.#within(fn)); }
  /** tasks: ids of the only tasks this section may have changed (kernel sections touching one task). */
  #save(state, durable = false, tasks) { return this.store.checkpoint(state, { durable, tasks }); }
  /** Persist every committed change now. */
  flush() { return this.#exclusive(() => this.store.flush()); }

  enqueue({ source, round, cwd, prompt, executors, title = source, projectId, issue, session, resultContract = false, basePrompt, continuationOf, workflowVersion, goalPrompt, workItems, ownerInstructions, continuationTiming = 'inherit' }) {
    return this.#section(async state => {
      if (!source || !round || !cwd || !prompt || !executors?.length)
        throw new Error('source, explicit round, local cwd, prompt and executors required');
      if (new Set(executors).size !== executors.length)
        throw new Error('executor instances must be unique');
      const key = JSON.stringify([source, round]);
      // Rounds are never enqueued twice, including rounds whose task was archived.
      const existing = keyTaken(state, key);
      if (existing) return existing;
      const prior = continuationOf && state.tasks.find(t => t.id === continuationOf);
      if (!['inherit', 'recheck'].includes(continuationTiming) || (continuationTiming === 'recheck' && (!prior || !ownerInstructions?.at(-1)?.trim())))
        throw new Error('Timing changes require an explicit owner continuation instruction');
      if (continuationOf && (!prior || !currentTask(prior, state) || prior.owner === 'human' ||
          !['review', 'accepted', 'blocked', 'decision', 'stalled', 'needs_result', 'stopped'].includes(prior.status)))
        throw new Error('Continue the current completed task, not a historical or active task');
      const issueIdentity = issueKey({ projectId, issue }, state);
      if (issueIdentity && state.tasks.some(t => issueKey(t, state) === issueIdentity &&
          (!terminal.has(t.status) || t.owner === 'human')))
        throw new Error('This issue already has an active or human-owned task');
      const task = { id: this.id(), key, cwd, prompt, title, executors: [...executors],
        status: 'queued', attempts: [], report: 'pending', owner: 'scheduler', events: [], resultContract,
        ...(basePrompt ? { basePrompt } : {}), ...(workflowVersion ? { workflowVersion } : {}),
        ...(goalPrompt ? { goalPrompt } : {}), ...(workItems ? { workItems } : {}),
        ...(ownerInstructions ? { ownerInstructions } : {}),
        ...(prior ? { continuationOf: prior.id, rootTaskId: prior.rootTaskId || prior.id,
          previousAttempts: [...(prior.previousAttempts || []), ...prior.attempts],
          rounds: [{ summary: prior.summary || prior.rounds?.at(-1)?.summary || '', outcome: prior.outcome,
            attempts: prior.attempts.length ? prior.attempts : (prior.previousAttempts || []).slice(-1), at: new Date().toISOString() }],
          ...(continuationTiming === 'recheck' ? {
            timingRevision: { mode: 'recheck', previousWindow: prior.resumeWindow || (prior.wait ? { notBefore: prior.wait.notBefore, expiresAt: prior.wait.expiresAt } : null),
              instruction: ownerInstructions.at(-1), at: new Date().toISOString() }
          } : { resumeWindow: prior.resumeWindow || (prior.wait ? { notBefore: prior.wait.notBefore, expiresAt: prior.wait.expiresAt } : undefined) }) } : {}),
        createdAt: new Date().toISOString(), ...(projectId ? { projectId } : {}),
        ...(issue ? { issue } : {}), ...(session ? { session } : {}),
        // An effort experiment arm stays with the issue's chain.
        ...(prior?.effortArm ? { effortArm: structuredClone(prior.effortArm) } : {}),
        // Unpublished automatic-round results travel with the chain instead of dying with the old task.
        ...(prior?.pendingRounds?.length ? { pendingRounds: prior.pendingRounds } : {}) };
      state.tasks.push(task);
      if (prior) {
        delete prior.pendingRounds;
        prior.supersededBy = task.id;
        if (prior.wait) prior.wait.status = 'superseded';
        prior.report = 'superseded';
      }
      for (const item of state.outbox || []) if (item.status === 'pending' && !currentTask(state.tasks.find(t => t.id === item.taskId) || {}, state)) item.status = 'superseded';
      await this.#save(state, true);
      return task.id;
    });
  }

  tick() {
    return this.#section(async state => {
      if (state.paused) return;
      // Every unresolved, non-queued task owns one automatic execution slot. The global
      // limit (settings.concurrency) and each project's limit (maxConcurrent) default to 1,
      // which keeps the original single-slot behavior.
      const active = state.tasks.filter(t => !terminal.has(t.status) && t.owner !== 'human');
      const occupied = active.filter(t => t.status !== 'queued');
      if (occupied.length >= globalLimit(state)) return;
      // A queued task whose inherited window has not opened yet must not hold up the tasks behind it.
      const notYet = t => t.resumeWindow?.notBefore && Date.now() < Date.parse(t.resumeWindow.notBefore);
      const task = active.find(t => t.status === 'queued' && !notYet(t) && hasSlot(t, occupied, state) &&
        (!t.admissionRetryAt || Date.now() >= t.admissionRetryAt) && !state.tasks.some(other => other.owner === 'human' && other.cwd === t.cwd));
      if (!task || task.status !== 'queued' || task.owner === 'human') return;
      if (task.resumeWindow?.expiresAt && Date.now() >= Date.parse(task.resumeWindow.expiresAt)) {
        task.status = 'blocked'; task.assessed = true; task.report = 'pending'; task.resumeNotice = false;
        if (!task.attempts.length && !task.summary && task.rounds?.length) {
          task.summary = task.rounds.at(-1).summary;
          task.outcome = task.rounds.at(-1).outcome;
        }
        if (task.wait) task.wait.status = 'expired';
        task.events.push({ action: 'window-expired', at: new Date().toISOString() });
        await this.#save(state, false, [task.id]); return;
      }
      if (task.resumeWindow?.notBefore && Date.now() < Date.parse(task.resumeWindow.notBefore)) return;
      if (this.beforeStart) {
        try { await this.beforeStart(task, state); delete task.admissionError; delete task.admissionRetryAt; }
        catch (error) {
          if (task.wait && (waitFaults[error.code] || error.code === 'WAIT_DEPENDENCY_PENDING')) {
            // A changed dependency receipt needs a new wait, not a retry with stale evidence.
            task.status = 'blocked'; task.assessed = true; task.report = 'pending'; task.resumeNotice = false;
            task.wait.status = 'invalid'; task.wait.failureNotified = true; task.wait.errorCode = error.code;
            task.wait.error = waitFaults[error.code] || '依赖完成回执已改变，需重新核验并设置等待条件。';
            task.events.push({ action: 'dependency-admission-blocked', at: new Date().toISOString() });
            await this.#save(state, false, [task.id]); return;
          }
          // Keep the queue intact for a transient outage, but never execute from stale assignment data.
          task.admissionError = '启动前 Linear 指派或状态复核未通过，未执行；稍后自动重查。';
          task.admissionRetryAt = Date.now() + 30000;
          await this.#save(state, false, [task.id]); return;
        }
      }
      for (let i = task.attempts.length; i < task.executors.length; i++) {
        const executor = task.executors[i];
        let extra = {};
        try { extra = this.startContext?.(task, state) || {}; } catch { /* optional start context never blocks a start */ }
        const attempt = { id: this.id(), executor, status: 'starting', sessionId: this.id(), startedAt: new Date().toISOString(),
          ...(task.session?.executor === executor ? { sessionId: task.session.id, resume: true } : {}) };
        task.attempts.push(attempt);
        task.status = 'starting';
        // Never call start until its intent is durable.
        await this.#save(state, true, [task.id]);
        let result;
        try {
          const adapter = this.adapters[executor];
          result = adapter && (!this.enabled || this.enabled(executor, state)) ? await bounded(() => adapter.start(structuredClone({ ...extra, task, attempt })))
            : { status: 'rejected', reason: 'Adapter unavailable; not started' };
        } catch {
          result = { status: 'unknown' };
        }
        this.#apply(task, attempt, result);
        await this.#save(state, true, [task.id]);
        if (attempt.status !== 'rejected') return;
      }
      task.status = 'exhausted';
      task.executionNotice = true; task.report = 'pending';
      await this.#save(state, false, [task.id]);
    });
  }

  #apply(task, attempt, result) {
    const previous = task.status;
    const status = result?.status;
    if (status === 'rejected') {
      attempt.status = 'rejected';
      task.status = 'queued';
    } else if (['running', 'finishing', 'waiting', 'review', 'failed'].includes(status)) {
      attempt.status = task.status = status;
      attempt.accepted = true;
    } else {
      attempt.status = task.status = 'unknown';
    }
    if (status === 'busy') attempt.status = task.status = 'busy';
    if (typeof result?.summary === 'string') task.summary = captureResultText(result.summary);
    if (typeof result?.reason === 'string') attempt.reason = result.reason.slice(0, 1000);
    if (typeof result?.sessionId === 'string') attempt.sessionId = result.sessionId;
    if (typeof result?.runId === 'string') attempt.runId = result.runId;
    if (result?.effort) {
      const { effort, arm, provider, model, error } = result.effort;
      task.events?.push({ action: error ? 'effort-select-failed' : 'effort-selected', effort, arm, provider, model,
        ...(error ? { error: String(error).slice(0, 300) } : {}), attemptId: attempt.id, at: new Date().toISOString() });
    }
    if (previous !== task.status) {
      task.report = 'pending';
      task.executionNotice = ['running', 'failed', 'unknown'].includes(task.status);
      task.events?.push({ action: task.status, at: new Date().toISOString(), attemptId: attempt.id });
    }
  }

  reconcile() {
    return this.#exclusive(async () => {
      const ids = (await this.store.read()).tasks
        .filter(t => !terminal.has(t.status) && t.owner !== 'human' && t.status !== 'queued').map(t => t.id);
      // Each running slot is reconciled independently; one task's failure must not skip the rest.
      let failure;
      for (const id of ids) {
        try { await this.#within(state => this.#reconcileOne(state, id)); } catch (error) { failure ??= error; }
      }
      if (failure) throw failure;
    });
  }

  async #reconcileOne(state, id) {
    const task = state.tasks.find(t => t.id === id);
    if (!task || terminal.has(task.status) || task.status === 'queued' || task.owner === 'human') return;
    const attempt = task.attempts.at(-1);
    const adapter = this.adapters[attempt.executor];
    let result;
    try { result = await bounded(() => adapter?.reconcile(structuredClone({ task, attempt }))); }
    catch { result = { status: 'unknown' }; }
    if (task.pendingStop && ['review', 'failed', 'stopped'].includes(result?.status)) {
      const action = task.pendingStop;
      attempt.status = 'stopped'; task.status = action === 'takeover' ? 'manual' : 'stopped';
      task.owner = action === 'takeover' ? 'human' : 'scheduler';
      if (task.wait) task.wait.status = 'suspended';
      delete task.pendingStop;
      task.events.push({ action, at: new Date().toISOString() });
      await this.#save(state, false, [task.id]); return;
    }
    // Once accepted, a later failure cannot become a pre-start rejection.
    if (result?.status === 'rejected' && attempt.accepted)
      result = { status: 'unknown' };
    if (attempt.status === 'busy' && result?.status === 'ready') {
      task.attempts.pop(); task.status = 'queued';
    } else this.#apply(task, attempt, result);
    await this.#save(state, false, [task.id]);
  }

  /** durable: persist before returning even inside a deferred cycle (before/after an external side effect). */
  update(fn, { durable = false } = {}) {
    return this.#section(async state => {
      const result = await fn(state);
      await this.#save(state, durable);
      return result;
    });
  }

  /**
   * freshSession (retry only): { sessionId, reason, handover } read by the caller outside this lock. When the
   * retried attempt is still that session, the retry starts a fresh session with the handover text prepended.
   */
  action(id, action, { confirmedIdle = false, freshSession } = {}) {
    return this.update(async state => {
      const task = state.tasks.find(t => t.id === id);
      if (!task) throw new Error('Task not found');
      if (!currentTask(task, state)) throw new Error('Historical task is superseded; open the current task');
      const attempt = task.attempts.at(-1);
      if (action === 'stop' || action === 'takeover') {
        if (!terminal.has(task.status) && task.status !== 'queued' && task.status !== 'busy') {
          task.status = 'stopping';
          task.pendingStop = action;
          await this.#save(state, true);
          let result;
          try { result = await bounded(() => this.adapters[attempt.executor]?.stop({ task, attempt })); }
          catch { result = null; }
          if (result?.status !== 'stopped') {
            task.status = 'unknown';
            task.events.push({ action: 'stop-unconfirmed', at: new Date().toISOString() });
            return;
          }
        }
        task.status = action === 'takeover' ? 'manual' : 'stopped';
        task.owner = action === 'takeover' ? 'human' : 'scheduler';
        delete task.pendingStop;
        if (task.wait) task.wait.status = 'suspended';
      } else if (action === 'return') {
        if (task.owner !== 'human') throw new Error('Task is not manually owned');
        if (attempt) {
          const adapter = this.adapters[attempt.executor];
          const result = await bounded(() => adapter?.verifyReturn ? adapter.verifyReturn({ task, attempt }) : adapter?.idle({ task, attempt }));
          if (result !== true && !(result === null && confirmedIdle)) throw new Error('Session idle state is unconfirmed; finish the manual session and confirm before returning');
        }
        task.owner = 'scheduler'; task.status = 'stopped';
      } else if (action === 'retry') {
        if (!['failed', 'exhausted', 'stopped'].includes(task.status)) throw new Error('Stop or reconcile before retry');
        const repair = repairRound(task);
        task.previousAttempts = [...(task.previousAttempts ?? []), ...task.attempts];
        const fresh = attempt?.accepted && freshSession?.sessionId === attempt.sessionId ? freshSession : null;
        if (fresh) {
          // Same executor, new session: the prompt keeps its ledger and previous-round summary.
          delete task.session; task.executors = [attempt.executor];
          task.prompt = `${fresh.handover}\n\n${task.prompt}`;
          task.sessionRounds = 0; task.recoveryStreak = 0;
          task.events.push({ action: 'fresh-session', reason: fresh.reason, at: new Date().toISOString() });
        } else if (attempt?.accepted) {
          task.session = { executor: attempt.executor, id: attempt.sessionId };
          task.executors = [attempt.executor];
        }
        task.attempts = []; task.status = 'queued'; task.report = 'pending'; task.assessed = false; task.outcome = null;
        task.formatRepair = false; task.autoRounds = 0; task.continuationIdleRounds = 0; task.lastProgress = '';
        // A retried working round takes the owner comments queued while it ran; a format-repair round keeps
        // them for the next working round.
        if (!repair) deliverPendingComments(task);
      } else if (action === 'accept') {
        if (task.status !== 'review') throw new Error('Task is not ready for review');
        if (!task.resultContract || task.outcome?.status !== 'complete') throw new Error('Completion evidence has not been classified');
        task.status = 'accepted';
        task.report = 'pending';
      } else throw new Error('Unsupported task action');
      task.events.push({ action, at: new Date().toISOString() });
    });
  }
}

/** Test-only persistence. A host must supply durable storage in production. */
export class MemoryStore {
  #state = { tasks: [] };
  async load() { return structuredClone(this.#state); }
  async save(state) { this.#state = structuredClone(state); }
}
