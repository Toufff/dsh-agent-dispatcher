import { randomUUID } from 'node:crypto';

export const terminal = new Set(['review', 'failed', 'exhausted', 'stopped', 'accepted', 'blocked', 'decision', 'stalled', 'needs_result']);
async function bounded(operation, ms = 15000) {
  let timer;
  try { return await Promise.race([Promise.resolve().then(operation), new Promise(resolve => {
    timer = setTimeout(() => resolve({ status: 'unknown', reason: 'Operation timed out; reconcile before continuing' }), ms);
  })]); } finally { clearTimeout(timer); }
}

/** A single-owner kernel. store.save must durably replace the aggregate atomically. */
export class Dispatcher {
  #tail = Promise.resolve();
  constructor({ store, adapters, id = randomUUID }) {
    this.store = store;
    this.adapters = adapters;
    this.id = id;
  }

  #exclusive(fn) {
    const result = this.#tail.then(fn);
    this.#tail = result.catch(() => {});
    return result;
  }

  enqueue({ source, round, cwd, prompt, executors, title = source, projectId, issue, session, resultContract = false, basePrompt }) {
    return this.#exclusive(async () => {
      if (!source || !round || !cwd || !prompt || !executors?.length)
        throw new Error('source, explicit round, local cwd, prompt and executors required');
      if (new Set(executors).size !== executors.length)
        throw new Error('executor instances must be unique');
      const state = await this.store.load();
      const key = JSON.stringify([source, round]);
      const existing = state.tasks.find(t => t.key === key);
      if (existing) return existing.id;
      const task = { id: this.id(), key, cwd, prompt, title, executors: [...executors],
        status: 'queued', attempts: [], report: 'pending', owner: 'scheduler', events: [], resultContract,
        ...(basePrompt ? { basePrompt } : {}),
        createdAt: new Date().toISOString(), ...(projectId ? { projectId } : {}),
        ...(issue ? { issue } : {}), ...(session ? { session } : {}) };
      state.tasks.push(task);
      await this.store.save(state);
      return task.id;
    });
  }

  tick() {
    return this.#exclusive(async () => {
      const state = await this.store.load();
      if (state.paused || state.tasks.some(t => t.owner === 'human')) return;
      // Any unresolved task owns the single automatic execution slot.
      const task = state.tasks.find(t => !terminal.has(t.status));
      if (!task || task.status !== 'queued' || task.owner === 'human') return;
      for (let i = task.attempts.length; i < task.executors.length; i++) {
        const executor = task.executors[i];
        const attempt = { id: this.id(), executor, status: 'starting', sessionId: this.id(),
          ...(task.session?.executor === executor ? { sessionId: task.session.id, resume: true } : {}) };
        task.attempts.push(attempt);
        task.status = 'starting';
        // Never call start until its intent is durable.
        await this.store.save(state);
        let result;
        try {
          const adapter = this.adapters[executor];
          result = adapter ? await bounded(() => adapter.start(structuredClone({ task, attempt })))
            : { status: 'rejected', reason: 'Adapter unavailable; not started' };
        } catch {
          result = { status: 'unknown' };
        }
        this.#apply(task, attempt, result);
        await this.store.save(state);
        if (attempt.status !== 'rejected') return;
      }
      task.status = 'exhausted';
      await this.store.save(state);
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
    if (typeof result?.summary === 'string') task.summary = result.summary.slice(0, 12000);
    if (typeof result?.reason === 'string') attempt.reason = result.reason.slice(0, 1000);
    if (typeof result?.sessionId === 'string') attempt.sessionId = result.sessionId;
    if (typeof result?.runId === 'string') attempt.runId = result.runId;
    if (previous !== task.status) task.events?.push({ action: task.status, at: new Date().toISOString(), attemptId: attempt.id });
  }

  reconcile() {
    return this.#exclusive(async () => {
      const state = await this.store.load();
      const task = state.tasks.find(t => !terminal.has(t.status));
      if (!task || task.status === 'queued' || task.owner === 'human') return;
      const attempt = task.attempts.at(-1);
      const adapter = this.adapters[attempt.executor];
      let result;
      try { result = await bounded(() => adapter?.reconcile(structuredClone({ task, attempt }))); }
      catch { result = { status: 'unknown' }; }
      // Once accepted, a later failure cannot become a pre-start rejection.
      if (result?.status === 'rejected' && attempt.accepted)
        result = { status: 'unknown' };
      if (attempt.status === 'busy' && result?.status === 'ready') {
        task.attempts.pop(); task.status = 'queued';
      } else this.#apply(task, attempt, result);
      await this.store.save(state);
    });
  }

  update(fn) {
    return this.#exclusive(async () => {
      const state = await this.store.load();
      const result = await fn(state);
      await this.store.save(state);
      return result;
    });
  }

  action(id, action, { confirmedIdle = false } = {}) {
    return this.update(async state => {
      const task = state.tasks.find(t => t.id === id);
      if (!task) throw new Error('Task not found');
      const attempt = task.attempts.at(-1);
      if (action === 'stop' || action === 'takeover') {
        if (!terminal.has(task.status) && task.status !== 'queued' && task.status !== 'busy') {
          task.status = 'stopping';
          await this.store.save(state);
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
        task.previousAttempts = [...(task.previousAttempts ?? []), ...task.attempts];
        if (attempt?.accepted) {
          task.session = { executor: attempt.executor, id: attempt.sessionId };
          task.executors = [attempt.executor];
        }
        task.attempts = []; task.status = 'queued'; task.report = 'pending'; task.assessed = false; task.outcome = null;
      } else if (action === 'accept') {
        if (task.status !== 'review') throw new Error('Task is not ready for review');
        if (!task.resultContract || task.outcome?.status !== 'complete') throw new Error('Completion evidence has not been classified');
        task.status = 'accepted';
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
