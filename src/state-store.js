import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Dispatcher state stores.
 *
 * The dispatcher kernel works on a draft of the aggregate state inside its single-owner lock and makes it
 * durable at checkpoints. Two implementations share that protocol:
 *
 * - LegacyStateStore wraps a whole-state store ({ load(), save(state) }: MemoryStore, FileStore). Every section
 *   loads a private copy and every checkpoint saves the whole state, as before. Readers get a frozen copy.
 * - TaskStore keeps the state in memory and tracks changes per record. Tasks and outbox items are records
 *   (keyed by id); every other top-level field is part of one small global document. A checkpoint compares
 *   records against shallow shadows instead of cloning and deep-comparing the whole state, and a flush writes
 *   only the records that changed. Updates inside a deferred scope (one dispatcher cycle) are flushed together;
 *   durable checkpoints (intent before an external side effect, every command) flush immediately.
 */

// Record shadows copy containers down to this depth and share everything below it. Code mutates records in
// place at most four levels deep (task.attempts[i].status, task.wait.seen.push); deeper values are only ever
// replaced. A periodic full JSON verification catches anything a shadow comparison would miss. The small
// global document (settings, sync cursors, notifications) is compared as JSON text, at any depth.
const SHADOW_DEPTH = 6;
const VERIFY_EVERY_MS = 60000;
const COLLECTIONS = ['tasks', 'outbox'];
const scope = new AsyncLocalStorage();

const container = value => value !== null && typeof value === 'object';
export function shadowOf(value, depth = 0) {
  if (!container(value) || depth >= SHADOW_DEPTH) return value;
  if (Array.isArray(value)) return value.map(item => shadowOf(item, depth + 1));
  const copy = {};
  for (const key of Object.keys(value)) copy[key] = shadowOf(value[key], depth + 1);
  return copy;
}
export function sameAs(live, shadow, depth = 0) {
  if (live === shadow) return true;
  if (!container(live) || !container(shadow) || depth >= SHADOW_DEPTH) return false;
  if (Array.isArray(live)) {
    if (!Array.isArray(shadow) || live.length !== shadow.length) return false;
    for (let i = 0; i < live.length; i++) if (!sameAs(live[i], shadow[i], depth + 1)) return false;
    return true;
  }
  if (Array.isArray(shadow)) return false;
  const keys = Object.keys(shadow);
  if (Object.keys(live).length !== keys.length) return false;
  for (const key of keys) if (!(key in live) || !sameAs(live[key], shadow[key], depth + 1)) return false;
  return true;
}
export function deepFreeze(value) {
  if (!container(value) || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return value;
}
const json = value => JSON.stringify(value);
const parse = text => JSON.parse(text);
function globalsOf(state) {
  const view = {};
  for (const key of Object.keys(state)) if (!COLLECTIONS.includes(key)) view[key] = state[key];
  return view;
}
function hidden(target, key, value) { Object.defineProperty(target, key, { value, enumerable: false, configurable: true, writable: true }); return target; }

/** Wraps any store into the draft/checkpoint protocol. */
export function asStateStore(store) { return store?.isStateStore ? store : new LegacyStateStore(store); }

/** Whole-state stores: one private copy per section, one whole-state save per checkpoint. */
export class LegacyStateStore {
  isStateStore = true;
  constructor(raw) { this.raw = raw; }
  archive = null;
  async begin() { return this.raw.load(); }
  async checkpoint(state) { await this.save(state); }
  rollback() {}
  async flush() {}
  deferred(fn) { return fn(); }
  /** A read-only copy; readers must never mutate state outside an update. */
  async read() { return deepFreeze(await this.raw.load()); }
  load() { return this.raw.load(); }
  save(state) { return this.raw.save(state); }
}

/**
 * In-memory backend for TaskStore (tests and tools). It keeps what a durable medium would hold: one JSON
 * document per record plus the global document with the record order.
 */
export class MemoryBackend {
  constructor(initial) {
    this.global = null; this.records = { tasks: new Map(), outbox: new Map() }; this.writes = [];
    if (initial) {
      const { tasks = [], outbox = [], ...globals } = structuredClone(initial);
      this.global = json({ ...globals, taskOrder: tasks.map(t => t.id), outboxOrder: outbox.map(i => i.id) });
      for (const t of tasks) this.records.tasks.set(t.id, json(t));
      for (const i of outbox) this.records.outbox.set(i.id, json(i));
    }
  }
  async loadAll() {
    const global = this.global ? parse(this.global) : null;
    return { global, records: { tasks: new Map([...this.records.tasks].map(([k, v]) => [k, parse(v)])),
      outbox: new Map([...this.records.outbox].map(([k, v]) => [k, parse(v)])) } };
  }
  /** Writes one batch in order: records, then the global document, then deletions. */
  async write(batch, written = () => {}) {
    if (this.fail) { const error = this.fail(batch); if (error) throw error; }
    this.writes.push(batch);
    for (const { table, id, text } of batch.puts) {
      if (this.failAfter !== undefined && this.failAfter-- <= 0) { this.failAfter = undefined; throw new Error('disk unavailable'); }
      this.records[table].set(id, text); written('put', table, id, text);
    }
    if (batch.global !== undefined) { this.global = batch.global; written('global', null, null, batch.global); }
    for (const { table, id } of batch.deletes) { this.records[table].delete(id); written('delete', table, id); }
  }
}

/** Assemble stored records into a state, in the stored order. Orphans are reported, never resurrected silently. */
export function assemble(global, records, isArchived = () => false) {
  const { taskOrder = [], outboxOrder = [], ...globals } = global || {};
  const state = { ...globals, tasks: [], outbox: [] };
  const orphans = [];
  for (const [table, order] of [['tasks', taskOrder], ['outbox', outboxOrder]]) {
    const listed = new Set(order);
    for (const id of order) if (records[table].has(id)) state[table].push(records[table].get(id));
    for (const [id, value] of records[table]) {
      if (listed.has(id)) continue;
      // A record written by a flush that did not reach its global document (crash) is restored at the end;
      // one left behind by archiving (or by a failed flush) is ignored and deleted by the next flush.
      if (isArchived(table, id)) orphans.push({ table, id });
      else state[table].push(value);
    }
  }
  return { state, orphans };
}

export class TaskStore {
  isStateStore = true;
  /** backend: { loadAll(), write(batch, written) }; options.initial seeds an empty medium. */
  constructor(backend, { archive = null, initial, clock = Date.now, log = () => {} } = {}) {
    this.backend = backend; this.archive = archive; this.initial = initial; this.clock = clock; this.log = log;
  }
  async open() {
    const { global, records } = await this.backend.loadAll();
    let state, orphans = [];
    if (global === null && !records.tasks.size && !records.outbox.size) state = structuredClone(this.initial ?? { tasks: [], outbox: [] });
    else ({ state, orphans } = assemble(global, records, (table, id) => this.archive?.has(table, id)));
    state.tasks ||= []; state.outbox ||= [];
    this.state = state;
    this.persisted = { tasks: new Map(), outbox: new Map(), order: { tasks: [], outbox: [] }, global: null };
    if (global !== null) {
      for (const table of COLLECTIONS) for (const [id, value] of records[table]) this.persisted[table].set(id, json(value));
      this.persisted.order = { tasks: global.taskOrder || [], outbox: global.outboxOrder || [] };
      this.persisted.global = json(global);
    }
    this.shadows = { tasks: new Map(), outbox: new Map(), order: { tasks: [], outbox: [] }, globals: null };
    this.dirty = { tasks: new Set(), outbox: new Set(), globals: false };
    this.snapshots = { tasks: new Map(), outbox: new Map(), globals: null };
    this.orphans = orphans;
    this.reshadowAll();
    if (global === null || orphans.length || this.state.tasks.length !== this.persisted.order.tasks.length ||
        this.state.outbox.length !== this.persisted.order.outbox.length) {
      for (const table of COLLECTIONS) for (const r of this.state[table]) this.dirty[table].add(r.id);
      this.dirty.globals = true;
    }
    this.verifiedAt = this.clock();
    return this;
  }
  reshadowAll() {
    for (const table of COLLECTIONS) {
      this.shadows[table] = new Map(this.state[table].map(r => [this.idOf(r, table), shadowOf(r)]));
      this.shadows.order[table] = this.state[table].map(r => r.id);
      this.snapshots[table].clear();
    }
    this.shadows.globals = json(globalsOf(this.state));
    this.snapshots.globals = null;
  }
  idOf(record, table) {
    if (typeof record?.id !== 'string' || !record.id) throw new Error(`Every ${table} record needs a string id`);
    return record.id;
  }

  // ---- kernel protocol ------------------------------------------------------------------------------------
  async begin() { return this.withArchive(this.state); }
  withArchive(state) { return this.archive ? hidden(state, 'archive', this.archive) : state; }
  /**
   * Record the draft's changes as committed. Durable unless called inside a deferred scope. `tasks` limits
   * the comparison to those task ids (kernel sections that touch one task); the global document is always checked.
   */
  async checkpoint(_state, { durable = false, tasks } = {}) {
    this.commit(tasks);
    if (durable || !scope.getStore()?.deferred) await this.flush();
  }
  /** Run fn with non-durable checkpoints deferred to the next flush (one dispatcher cycle). */
  deferred(fn) { return scope.run({ deferred: true }, fn); }
  commit(only) {
    const state = this.state;
    for (const table of COLLECTIONS) {
      const list = state[table] ||= [], shadows = this.shadows[table], seen = new Set();
      const order = this.shadows.order[table];
      if (only && table === 'outbox' && list.length === order.length && list.every((r, i) => r.id === order[i])) continue;
      for (const record of list) {
        const id = this.idOf(record, table);
        if (seen.has(id)) throw new Error(`Duplicate ${table} id ${id}`);
        seen.add(id);
        if (only && table === 'tasks' && !only.includes(id) && shadows.has(id)) continue;
        const shadow = shadows.get(id);
        if (shadow === undefined || !sameAs(record, shadow)) {
          shadows.set(id, shadowOf(record)); this.dirty[table].add(id); this.snapshots[table].delete(id);
        }
      }
      for (const id of [...shadows.keys()]) if (!seen.has(id)) {
        shadows.delete(id); this.dirty[table].add(id); this.snapshots[table].delete(id);
      }
      if (order.length !== list.length || list.some((r, i) => r.id !== order[i])) {
        this.shadows.order[table] = list.map(r => r.id); this.dirty.globals = true;
      }
    }
    const globals = json(globalsOf(state));
    if (globals !== this.shadows.globals) {
      this.shadows.globals = globals; this.dirty.globals = true; this.snapshots.globals = null;
    }
    if (this.clock() - this.verifiedAt >= VERIFY_EVERY_MS) this.verify();
  }
  /** Full JSON comparison against what was persisted; a change missed by the shadows is persisted anyway. */
  verify() {
    this.verifiedAt = this.clock();
    for (const table of COLLECTIONS) for (const [id, shadow] of this.shadows[table]) {
      if (this.dirty[table].has(id)) continue;
      const record = this.state[table].find(r => r.id === id);
      if (record && json(record) !== this.persisted[table].get(id)) {
        this.log(`state change outside tracked depth: ${table}/${id}`);
        this.shadows[table].set(id, shadowOf(record)); this.dirty[table].add(id); this.snapshots[table].delete(id);
      }
    }
  }
  /** Discard uncommitted changes of the draft. Unchanged records keep their identity. */
  rollback() {
    const state = this.state;
    for (const table of COLLECTIONS) {
      const live = new Map((Array.isArray(state[table]) ? state[table] : []).filter(r => r?.id).map(r => [r.id, r]));
      state[table] = this.shadows.order[table].map(id => {
        const shadow = this.shadows[table].get(id), record = live.get(id);
        return record && sameAs(record, shadow) ? record : shadowOf(shadow);
      });
    }
    if (json(globalsOf(state)) !== this.shadows.globals) {
      for (const key of Object.keys(state)) if (!COLLECTIONS.includes(key)) delete state[key];
      Object.assign(state, parse(this.shadows.globals));
    }
  }
  /** Persist every committed change. On failure the state returns to the last persisted one. */
  async flush() {
    const { dirty } = this;
    if (!dirty.globals && !dirty.tasks.size && !dirty.outbox.size && !this.orphans.length) return;
    const puts = [], deletes = [...this.orphans];
    for (const table of COLLECTIONS) for (const id of dirty[table]) {
      const shadow = this.shadows[table].get(id);
      if (shadow === undefined) { if (this.persisted[table].has(id)) deletes.push({ table, id }); continue; }
      const text = json(shadow);
      if (text !== this.persisted[table].get(id)) puts.push({ table, id, text });
    }
    const globalText = json({ ...parse(this.shadows.globals), taskOrder: this.shadows.order.tasks, outboxOrder: this.shadows.order.outbox });
    const batch = { puts, deletes, global: globalText !== this.persisted.global ? globalText : undefined };
    try {
      if (puts.length || deletes.length || batch.global !== undefined) await this.backend.write(batch, (kind, table, id, text) => {
        if (kind === 'put') this.persisted[table].set(id, text);
        else if (kind === 'delete') this.persisted[table].delete(id);
        else { this.persisted.global = text; const g = parse(text); this.persisted.order = { tasks: g.taskOrder, outbox: g.outboxOrder }; }
      });
      this.orphans = [];
      dirty.tasks.clear(); dirty.outbox.clear(); dirty.globals = false;
    } catch (error) {
      this.revert();
      throw error;
    }
  }
  /** Return memory to the persisted state (after a failed write). */
  revert() {
    const global = this.persisted.global ? parse(this.persisted.global) : null;
    const records = { tasks: new Map(), outbox: new Map() };
    for (const table of COLLECTIONS) for (const [id, text] of this.persisted[table]) records[table].set(id, parse(text));
    const { state, orphans } = global ? assemble(global, records, () => true) : { state: structuredClone(this.initial ?? { tasks: [], outbox: [] }), orphans: [] };
    // Records written by the failed batch but no longer listed are deleted by the next successful flush.
    this.orphans = orphans;
    for (const key of Object.keys(this.state)) delete this.state[key];
    Object.assign(this.state, state);
    this.state.tasks ||= []; this.state.outbox ||= [];
    this.reshadowAll();
    this.dirty = { tasks: new Set(), outbox: new Set(), globals: false };
  }

  // ---- readers --------------------------------------------------------------------------------------------
  /** A frozen view of the committed state. Unchanged records are shared between calls. */
  async read() {
    const snap = this.snapshots;
    snap.globals ||= deepFreeze(parse(this.shadows.globals));
    const view = { ...snap.globals };
    for (const table of COLLECTIONS) view[table] = this.shadows.order[table].map(id => {
      let value = snap[table].get(id);
      if (!value) { value = deepFreeze(structuredClone(this.shadows[table].get(id))); snap[table].set(id, value); }
      return value;
    });
    return this.withArchive(view);
  }
  /** A private mutable copy of the committed state (tools and tests). */
  async load() { return structuredClone(await this.read()); }
  /** Replace the whole state (tools and tests). */
  async save(state) {
    const copy = structuredClone(state);
    for (const key of Object.keys(this.state)) delete this.state[key];
    Object.assign(this.state, copy, { tasks: copy.tasks || [], outbox: copy.outbox || [] });
    this.commit(); await this.flush();
  }
}

