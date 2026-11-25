import { randomUUID } from 'node:crypto';
import { captureResultText } from './result-text.js';
import { waitFaults } from './followup.js';
import { currentTask, issueKey, keyTaken, repairRound, deliverPendingComments, withHandover } from './workflow.js';
import { asStateStore } from './state-store.js';

export const terminal = new Set(['review', 'failed', 'exhausted', 'stopped', 'accepted', 'blocked', 'decision', 'stalled', 'needs_result']);
async function bounded(operation, ms = 15000) {
  let timer;
  try { return await Promise.race([Promise.resolve().then(operation), new Promise(resolve => {
    timer = setTimeout(() => resolve({ status: 'unknown', reason: 'Operation timed out; reconcile before continuing' }), ms);
  })]); } finally { clearTimeout(timer); }
}

/** The task fields an adapter may need while reconciling an attempt. */
const reconcileView = ({ id, cwd, status, executors, session, projectId, issue }) => ({ id, cwd, status, executors, session, projectId, issue });
const slotGroup = task => task.projectId ? `project:${task.projectId}` : `cwd:${task.cwd}`;
export function globalLimit(state) { return Math.max(1, state.settings?.concurrency ?? 1); }
/** How many queued tasks one tick may start (settings.startConcurrency, default 6). */
export function startLimit(state) { return Math.max(1, state.settings?.startConcurrency ?? 6); }
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
      // Status reports of the replaced task are obsolete; a round report is a finished round's result and is always sent.
      for (const item of state.outbox || []) if (item.status === 'pending' && !item.roundReport && !currentTask(state.tasks.find(t => t.id === item.taskId) || {}, state)) item.status = 'superseded';
      await this.#save(state, true);
      return task.id;
    });
  }

  /**
   * Starts as many queued tasks as there are free slots, at most startLimit per tick. Admission checks (Linear
   * eligibility) and adapter starts of the picked tasks run in parallel; every start intent is durable before any
   * start call. A rejected start falls back to the task's next executor in the following parallel wave.
   */
  tick() {
    return this.#section(async state => {
      if (state.paused) return;
      // Every unresolved, non-queued task owns one automatic execution slot. The global
      // limit (settings.concurrency) and each project's limit (maxConcurrent) default to 1,
      // which keeps the original single-slot behavior.
      const active = state.tasks.filter(t => !terminal.has(t.status) && t.owner !== 'human');
      const occupied = active.filter(t => t.status !== 'queued');
      const free = Math.min(globalLimit(state) - occupied.length, startLimit(state));
      if (free <= 0) return;
      // A queued task whose inherited window has not opened yet must not hold up the tasks behind it.
      const notYet = t => t.resumeWindow?.notBefore && Date.now() < Date.parse(t.resumeWindow.notBefore);
      const picked = [];
      for (const t of active) {
        if (picked.length >= free) break;
        if (t.status === 'queued' && !notYet(t) && hasSlot(t, [...occupied, ...picked], state) &&
            (!t.admissionRetryAt || Date.now() >= t.admissionRetryAt) && !state.tasks.some(other => other.owner === 'human' && !other.manualParked && other.cwd === t.cwd))
          picked.push(t);
      }
      if (!picked.length) return;
      const ids = picked.map(t => t.id);
      const ready = picked.filter(task => {
        if (!task.resumeWindow?.expiresAt || Date.now() < Date.parse(task.resumeWindow.expiresAt)) return true;
        task.status = 'blocked'; task.assessed = true; task.report = 'pending'; task.resumeNotice = false;
        if (!task.attempts.length && !task.summary && task.rounds?.length) {
          task.summary = task.rounds.at(-1).summary;
          task.outcome = task.rounds.at(-1).outcome;
        }
        if (task.wait) task.wait.status = 'expired';
        task.events.push({ action: 'window-expired', at: new Date().toISOString() });
        return false;
      });
      let admitted = ready;
      if (this.beforeStart && ready.length) {
        const checks = await Promise.allSettled(ready.map(task => Promise.resolve().then(() => this.beforeStart(task, state))));
        admitted = ready.filter((task, i) => {
          if (checks[i].status === 'fulfilled') { delete task.admissionError; delete task.admissionRetryAt; return true; }
          const error = checks[i].reason || {};
          if (task.wait && (waitFaults[error.code] || error.code === 'WAIT_DEPENDENCY_PENDING')) {
            // A changed dependency receipt needs a new wait, not a retry with stale evidence.
            task.status = 'blocked'; task.assessed = true; task.report = 'pending'; task.resumeNotice = false;
            task.wait.status = 'invalid'; task.wait.failureNotified = true; task.wait.errorCode = error.code;
            task.wait.error = waitFaults[error.code] || '依赖完成回执已改变，需重新核验并设置等待条件。';
            task.events.push({ action: 'dependency-admission-blocked', at: new Date().toISOString() });
            return false;
          }
          // Keep the queue intact for a transient outage, but never execute from stale assignment data.
          task.admissionError = '启动前 Linear 指派或状态复核未通过，未执行；稍后自动重查。';
          task.admissionRetryAt = Date.now() + 30000;
          return false;
        });
      }
      if (!admitted.length) { await this.#save(state, false, ids); return; }
      // Waves: each admitted task tries its next executor; a definitive rejection moves it to the next wave.
      for (let wave = admitted; wave.length;) {
        const starts = [];
        for (const task of wave) {
          const executor = task.executors[task.attempts.length];
          if (!executor) { task.status = 'exhausted'; task.executionNotice = true; task.report = 'pending'; continue; }
          let extra = {};
          try { extra = this.startContext?.(task, state) || {}; } catch { /* optional start context never blocks a start */ }
          const attempt = { id: this.id(), executor, status: 'starting', sessionId: this.id(), startedAt: new Date().toISOString(),
            ...(task.session?.executor === executor ? { sessionId: task.session.id, resume: true } : {}) };
          task.attempts.push(attempt);
          task.status = 'starting';
          starts.push({ task, attempt, executor, extra });
        }
        // Never call start until its intent is durable.
        await this.#save(state, true, ids);
        const results = await Promise.all(starts.map(async ({ task, attempt, executor, extra }) => {
          try {
            const adapter = this.adapters[executor];
            return adapter && (!this.enabled || this.enabled(executor, state)) ? await bounded(() => adapter.start(structuredClone({ ...extra, task, attempt })))
              : { status: 'rejected', reason: 'Adapter unavailable; not started' };
          } catch { return { status: 'unknown' }; }
        }));
        starts.forEach(({ task, attempt }, i) => this.#apply(task, attempt, results[i]));
        await this.#save(state, true, ids);
        wave = starts.filter(s => s.attempt.status === 'rejected').map(s => s.task);
      }
    });
  }

  #apply(task, attempt, result) {
    const previous = task.status;
    const status = result?.status;
    if (status === 'rejected') {
      attempt.status = 'rejected';
      task.status = 'queued';
    } else if (status === 'interrupted') {
      // The executor died mid-round (host restart). Requeue the way retry does — keep the same session so start()
      // resumes it (attempt.resume) instead of opening a new one — rather than parking the task in 'unknown', which
      // neither continue nor retry accepts and so blocked every release until all rounds happened to finish.
      attempt.status = 'unknown';
      task.previousAttempts = [...(task.previousAttempts ?? []), ...task.attempts];
      task.session = { executor: attempt.executor, id: attempt.sessionId };
      task.executors = [attempt.executor];
      task.attempts = [];
      task.status = 'queued';
      task.report = 'pending';
      task.assessed = false;
      task.outcome = null;
      task.autoRounds = 0;
      task.continuationIdleRounds = 0;
      task.lastProgress = '';
      task.events?.push({ action: 'interrupted', at: new Date().toISOString(), attemptId: attempt.id,
        reason: String(result?.reason || '').slice(0, 300) });
    } else if (status === 'needs_input') {
      // An unattended round stopped on a question to a person (NeedsInput). It settles as a decision with the
      // question as its blocker: reported to Linear and notified like any decision; an owner answer in Linear
      // continues it in the same session. The adapter already cancelled the blocked turn.
      const question = String(result.question || '').trim().slice(0, 2000);
      const asked = question || '（问题正文未能读取，请打开会话查看）';
      attempt.status = 'stopped'; attempt.accepted = true;
      task.status = 'decision'; task.assessed = true;
      task.inputRequest = { kind: result.reason || 'question', question, attemptId: attempt.id, cancelled: Boolean(result.cancelled), at: new Date().toISOString() };
      task.summary = `The unattended round stopped on a question to a person (ask_user_question) instead of returning a result:\n${asked}`;
      task.outcome = { status: 'decision', evidence: [], remaining: ['回答执行者在无人值守执行中提出的问题'], next: '', progress: '',
        blockers: [{ owner: '本地负责人', reason: `执行者提问：${asked}`.slice(0, 2000), resumeWhen: '在 Linear 评论中回答后自动续办' }],
        publicSummary: `执行者在无人值守执行中提出了问题，需要回答后才能继续：\n${asked}`.slice(0, 4000) };
      if (task.wait) task.wait.status = 'resolved';
      task.events?.push({ action: 'input-required', kind: task.inputRequest.kind, attemptId: attempt.id, at: task.inputRequest.at });
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
    // Adapters reconcile an attempt, not the task's history: copying the whole task (prompt, rounds, events) for
    // every running task on every pass was most of the reconcile cost.
    try { result = await bounded(() => adapter?.reconcile(structuredClone({ task: reconcileView(task), attempt }))); }
    catch { result = { status: 'unknown' }; }
    if (task.pendingStop && ['review', 'failed', 'stopped', 'needs_input'].includes(result?.status)) {
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
        // A takeover of a round that was executing hands a live session to a person, who may now be editing the
        // working directory; taking over an already settled task only parks it (e.g. a parent waiting for children).
        const parkedOnly = action === 'takeover' && (terminal.has(task.status) || task.status === 'queued');
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
        if (action === 'takeover') task.manualParked = parkedOnly; else delete task.manualParked;
        delete task.pendingStop;
        if (task.wait) task.wait.status = 'suspended';
      } else if (action === 'return') {
        if (task.owner !== 'human') throw new Error('Task is not manually owned');
        if (attempt) {
          const adapter = this.adapters[attempt.executor];
          const result = await bounded(() => adapter?.verifyReturn ? adapter.verifyReturn({ task, attempt }) : adapter?.idle({ task, attempt }));
          if (result !== true && !(result === null && confirmedIdle)) throw new Error('Session idle state is unconfirmed; finish the manual session and confirm before returning');
        }
        task.owner = 'scheduler'; task.status = 'stopped'; delete task.manualParked;
      } else if (action === 'retry') {
        if (!['failed', 'exhausted', 'stopped'].includes(task.status)) throw new Error('Stop or reconcile before retry');
        const repair = repairRound(task);
        task.previousAttempts = [...(task.previousAttempts ?? []), ...task.attempts];
        const fresh = attempt?.accepted && freshSession?.sessionId === attempt.sessionId ? freshSession : null;
        if (fresh) {
          // Same executor, new session: the prompt keeps its ledger and previous-round summary.
          delete task.session; task.executors = [attempt.executor];
          // One handover only: an earlier one (from a previous retry) is stale and is replaced.
          task.prompt = withHandover(task.prompt, fresh.handover);
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
