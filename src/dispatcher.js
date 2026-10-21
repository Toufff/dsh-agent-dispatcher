import { randomUUID } from 'node:crypto';

const terminal = new Set(['review', 'failed', 'exhausted']);

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

  enqueue({ source, round, cwd, prompt, executors }) {
    return this.#exclusive(async () => {
      if (!source || !round || !cwd || !prompt || !executors?.length)
        throw new Error('source, explicit round, local cwd, prompt and executors required');
      if (new Set(executors).size !== executors.length)
        throw new Error('executor instances must be unique');
      const state = await this.store.load();
      const key = JSON.stringify([source, round]);
      const existing = state.tasks.find(t => t.key === key);
      if (existing) return existing.id;
      const task = { id: this.id(), key, cwd, prompt, executors: [...executors],
        status: 'queued', attempts: [], report: 'pending' };
      state.tasks.push(task);
      await this.store.save(state);
      return task.id;
    });
  }

  tick() {
    return this.#exclusive(async () => {
      const state = await this.store.load();
      // Any unresolved task owns the single automatic execution slot.
      const task = state.tasks.find(t => !terminal.has(t.status));
      if (!task || task.status !== 'queued') return;
      for (let i = task.attempts.length; i < task.executors.length; i++) {
        const executor = task.executors[i];
        const attempt = { id: this.id(), executor, status: 'starting' };
        task.attempts.push(attempt);
        task.status = 'starting';
        // Never call start until its intent is durable.
        await this.store.save(state);
        let result;
        try {
          const adapter = this.adapters[executor];
          result = adapter ? await adapter.start(structuredClone({ task, attempt }))
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
    const status = result?.status;
    if (status === 'rejected') {
      attempt.status = 'rejected';
      task.status = 'queued';
    } else if (['running', 'waiting', 'review', 'failed'].includes(status)) {
      attempt.status = task.status = status;
      attempt.accepted = true;
    } else {
      attempt.status = task.status = 'unknown';
    }
    if (typeof result?.sessionId === 'string') attempt.sessionId = result.sessionId;
    if (typeof result?.runId === 'string') attempt.runId = result.runId;
  }

  reconcile() {
    return this.#exclusive(async () => {
      const state = await this.store.load();
      const task = state.tasks.find(t => !terminal.has(t.status));
      if (!task || task.status === 'queued') return;
      const attempt = task.attempts.at(-1);
      const adapter = this.adapters[attempt.executor];
      let result;
      try { result = await adapter?.reconcile(structuredClone({ task, attempt })); }
      catch { result = { status: 'unknown' }; }
      // Once accepted, a later failure cannot become a pre-start rejection.
      if (result?.status === 'rejected' && attempt.accepted)
        result = { status: 'unknown' };
      this.#apply(task, attempt, result);
      await this.store.save(state);
    });
  }
}

/** Test-only persistence. A host must supply durable storage in production. */
export class MemoryStore {
  #state = { tasks: [] };
  async load() { return structuredClone(this.#state); }
  async save(state) { this.#state = structuredClone(state); }
}
