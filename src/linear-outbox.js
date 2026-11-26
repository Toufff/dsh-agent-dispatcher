import { randomUUID } from 'node:crypto';
import { syncKey, linearMapping } from './linear.js';

/**
 * Linear merged exit (Linear 合批出口).
 *
 * Every Linear write of this host — task reports, state moves and writes enqueued by local scripts through the
 * 'linear-enqueue' RPC — waits in the durable outbox (state.outbox) and leaves in ONE aliased GraphQL mutation per
 * credential and flush (chunked at maxPerRequest aliases). Reads that used to happen per task use the sync cache
 * (IssueCache) or one batched read. Linear failures never rerun coding: a failed alias is retried alone, with backoff.
 */
export const batchDefaults = { flushIntervalMs: 30000, flushPending: 20, maxPerRequest: 25, hourlyBudget: 2500, warnFraction: 0.6,
  cacheMaxAgeMs: 120000, maxTries: 12, maxRequestBytes: 400000, workspaceCheckMs: 3600000 };
export const batchPolicy = settings => ({ ...batchDefaults, ...(settings?.linearBatch || {}) });

export const CALLERS = ['director', 'push-queue', 'ops'];
const ISSUE_REF = /^(?:[A-Z][A-Z0-9]{0,9}-\d{1,7}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const ID = /^[0-9A-Za-z_-]{1,80}$/;
const UPDATE_FIELDS = ['stateId', 'labelIds', 'delegateId'];
const CREATE_FIELDS = ['teamId', 'projectId', 'title', 'description', 'delegateToBot', 'assigneeId', 'labelIds', 'stateId'];
const fail = message => Object.assign(new Error(message), { code: 'LINEAR_ENQUEUE_INVALID' });
const idList = (value, name) => {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 50 || !value.every(v => typeof v === 'string' && ID.test(v))) throw fail(`${name} 必须是 id 数组`);
  return value;
};
const idValue = (value, name) => {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !ID.test(value)) throw fail(`${name} 不是合法 id`);
  return value;
};

/** Validates and normalizes one 'linear-enqueue' op (whitelisted fields only). */
export function normalizeOp(op) {
  if (!op || typeof op !== 'object') throw fail('缺少 op');
  if (op.kind === 'comment') {
    if (typeof op.issue !== 'string' || !ISSUE_REF.test(op.issue)) throw fail('comment.issue 必须是 LON-123 或 issue id');
    if (typeof op.body !== 'string' || !op.body.trim() || op.body.length > 60000) throw fail('comment.body 为空或过长');
    return { kind: 'comment', issue: op.issue, body: op.body };
  }
  if (op.kind === 'issueCreate') {
    const input = op.input || {};
    const extra = Object.keys(input).filter(k => !CREATE_FIELDS.includes(k));
    if (extra.length) throw fail(`issueCreate 不允许字段：${extra.join(', ')}`);
    if (typeof input.title !== 'string' || !input.title.trim() || input.title.length > 500) throw fail('issueCreate.title 为空或过长');
    if (input.description !== undefined && (typeof input.description !== 'string' || input.description.length > 100000)) throw fail('issueCreate.description 过长');
    if (input.delegateToBot !== undefined && typeof input.delegateToBot !== 'boolean') throw fail('delegateToBot 必须是布尔值');
    const clean = { title: input.title, ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.delegateToBot ? { delegateToBot: true } : {}) };
    for (const k of ['teamId', 'projectId', 'assigneeId', 'stateId']) { const v = idValue(input[k], k); if (v) clean[k] = v; }
    const labels = idList(input.labelIds, 'labelIds'); if (labels) clean.labelIds = labels;
    return { kind: 'issueCreate', input: clean };
  }
  if (op.kind === 'issueUpdate') {
    if (typeof op.issue !== 'string' || !ISSUE_REF.test(op.issue)) throw fail('issueUpdate.issue 必须是 LON-123 或 issue id');
    const input = op.input || {};
    const extra = Object.keys(input).filter(k => !UPDATE_FIELDS.includes(k));
    if (extra.length) throw fail(`issueUpdate 只允许 ${UPDATE_FIELDS.join(', ')}，不允许：${extra.join(', ')}`);
    const clean = {};
    for (const k of ['stateId', 'delegateId']) { const v = idValue(input[k], k); if (v) clean[k] = v; }
    const labels = idList(input.labelIds, 'labelIds'); if (labels) clean.labelIds = labels;
    if (!Object.keys(clean).length) throw fail('issueUpdate.input 为空');
    return { kind: 'issueUpdate', issue: op.issue, input: clean };
  }
  throw fail('op.kind 只能是 comment / issueCreate / issueUpdate');
}

/** The local project whose credential sends an external op (Linear project id, a task's issue, or the cache). */
export function externalProject(op, state, cache) {
  const enabled = state.settings.projects.filter(p => p.linear?.enabled);
  if (op.kind === 'issueCreate' && op.input.projectId) {
    const byProject = enabled.find(p => p.linear.projectId === op.input.projectId);
    if (byProject) return byProject;
  }
  const ref = op.issue;
  if (ref) {
    const upper = ref.toUpperCase();
    const task = [...state.tasks].reverse().find(t => t.issue && (t.issue.id === ref || t.issue.identifier?.toUpperCase() === upper));
    const byTask = task && enabled.find(p => p.id === task.projectId);
    if (byTask) return byTask;
    const cached = cache?.find(ref);
    const byCache = cached && enabled.find(p => p.linear.projectId === cached.project?.id);
    if (byCache) return byCache;
  }
  // No silent fallback to some project: only when exactly one project has Linear enabled is the target unambiguous.
  // (Its credential's workspace is still verified before anything is sent.)
  return enabled.length === 1 ? enabled[0] : null;
}

/** 'linear-enqueue': durable, deduplicated by (caller, idempotencyKey). Runs inside a dispatcher update. */
export function enqueueExternal(state, request, cache, archive = state.archive) {
  if (!CALLERS.includes(request.caller)) throw fail(`caller 只能是 ${CALLERS.join(' / ')}`);
  if (typeof request.idempotencyKey !== 'string' || !request.idempotencyKey || request.idempotencyKey.length > 200) throw fail('缺少 idempotencyKey');
  const op = normalizeOp(request.op);
  const same = i => i.external && i.caller === request.caller && i.idempotencyKey === request.idempotencyKey;
  const existing = state.outbox.find(same) || archive?.outboxItems?.().find(same);
  if (existing) return { id: existing.id, status: 'duplicate' };
  const project = externalProject(op, state, cache);
  if (!project) throw fail('无法确定用哪个项目的 Linear 凭据发送：请给 issueCreate 带 projectId，或改用已被同步过的工单');
  const item = { id: randomUUID(), external: true, caller: request.caller, idempotencyKey: request.idempotencyKey, op,
    projectId: project.id, status: 'pending', tries: 0, createdAt: new Date().toISOString() };
  state.outbox.push(item);
  return { id: item.id, status: 'queued' };
}

/** 'linear-result': read-only status of enqueued writes. */
export function externalResults(state, ids, archive = state.archive) {
  if (!Array.isArray(ids) || ids.length > 500) throw fail('ids 必须是数组（最多 500）');
  const archived = new Map((archive?.outboxItems?.() || []).map(i => [i.id, i]));
  return ids.map(id => {
    const item = state.outbox.find(i => i.id === id) || archived.get(id);
    if (!item?.external) return { id, status: 'failed', error: 'unknown id' };
    const status = item.status === 'sent' ? 'sent' : item.status === 'failed' ? 'failed' : item.tries > 0 ? 'retrying' : 'queued';
    return { id, status, ...(item.result ? { result: item.result } : {}), ...(item.lastError && status !== 'sent' ? { error: item.lastError } : {}) };
  });
}

/**
 * The dispatcher's view of Linear, filled ONLY by reads it already makes (sync intake, the watched read, batched
 * admission reads, comment sweeps, write results). Never reads the network itself.
 */
export class IssueCache {
  constructor(now = Date.now) { this.now = now; this.issues = new Map(); this.comments = new Map(); this.users = new Map(); this.cacheAt = null; }
  /**
   * A read's view of an issue. `partial` (write results: identifier / state only) updates the fields but never makes
   * an entry fresher: freshness only comes from a full read, so admission never trusts an old assignee.
   */
  put(issue, at = this.now(), partial = false) {
    if (!issue?.id) return;
    const old = this.issues.get(issue.id);
    this.issues.set(issue.id, { issue: { ...(old?.issue || {}), ...issue }, at: partial ? old?.at ?? 0 : at });
    if (this.issues.size > 5000) for (const key of [...this.issues.keys()].slice(0, this.issues.size - 5000)) this.issues.delete(key);
  }
  putState(id, state) { const old = this.issues.get(id); if (old) this.put({ id, state: { ...(old.issue.state || {}), ...state }, updatedAt: new Date(this.now()).toISOString() }, undefined, true); }
  putComment(comment, at = this.now()) {
    if (!comment?.id) return;
    this.comments.set(comment.id, { ...(this.comments.get(comment.id) || {}), ...comment, seenAt: at });
    if (this.comments.size > 5000) for (const key of [...this.comments.keys()].slice(0, this.comments.size - 5000)) this.comments.delete(key);
  }
  synced(at = this.now()) { this.cacheAt = at; }
  get(id) { return this.issues.get(id) || null; }
  find(ref) {
    if (!ref) return null;
    const direct = this.issues.get(ref)?.issue;
    if (direct) return direct;
    const upper = String(ref).toUpperCase();
    for (const { issue } of this.issues.values()) if (issue.identifier?.toUpperCase() === upper) return issue;
    return null;
  }
  /** A cached issue seen within maxAgeMs, else null (callers then read fresh, batched, or fail closed). */
  fresh(id, maxAgeMs) { const e = this.issues.get(id); return e && this.now() - e.at <= maxAgeMs ? e.issue : null; }
  /** 'linear-view' payload: bounded, cache only. */
  view({ projectId, since, include = ['issues', 'comments'] } = {}, { ownIds = new Set(), botIds = new Set() } = {}) {
    const after = since ? Date.parse(since) : null;
    if (since && !Number.isFinite(after)) throw fail('since 必须是 ISO 时间');
    const out = { cacheAt: this.cacheAt ? new Date(this.cacheAt).toISOString() : null };
    if (include.includes('issues')) {
      out.issues = [...this.issues.values()].map(e => e.issue)
        .filter(i => (!projectId || i.project?.id === projectId) && (!after || Date.parse(i.updatedAt || 0) >= after))
        .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''))).slice(0, 500)
        .map(i => ({ id: i.id, identifier: i.identifier || null, title: i.title ?? null, state: i.state || null,
          assigneeId: i.assignee?.id || null, delegateId: i.delegate?.id || null, updatedAt: i.updatedAt || null }));
    }
    if (include.includes('comments')) {
      out.comments = [...this.comments.values()]
        .filter(c => (!after || Date.parse(c.createdAt || 0) >= after) && (!projectId || !c.projectId || c.projectId === projectId ||
          this.issues.get(c.issueId)?.issue.project?.id === projectId))
        .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))).slice(0, 500)
        .map(c => ({ id: c.id, issueIdentifier: c.issueIdentifier || this.issues.get(c.issueId)?.issue.identifier || null,
          authorId: c.authorId || null, authorIsBot: ownIds.has(c.id) || botIds.has(c.authorId), body: String(c.body ?? '').slice(0, 20000), createdAt: c.createdAt || null }));
    }
    return out;
  }
}
/** Normalizes a Linear comment node into the cache shape. */
export const cacheComment = (c, projectId) => ({ id: c.id, issueId: c.issue?.id || c.issueId, issueIdentifier: c.issue?.identifier,
  authorId: c.user?.id || null, ...(c.body !== undefined ? { body: c.body } : {}), createdAt: c.createdAt, updatedAt: c.updatedAt, projectId });

/** Linear HTTP requests per caller / purpose, per clock hour (snapshot linearUsage). */
export class LinearUsage {
  constructor(now = Date.now) { this.now = now; this.hours = new Map(); }
  count(caller = 'dispatcher', purpose = 'other') {
    const hour = new Date(this.now()).toISOString().slice(0, 13);
    if (!this.hours.has(hour)) { this.hours.set(hour, new Map()); for (const k of [...this.hours.keys()].slice(0, -3)) this.hours.delete(k); }
    const bucket = this.hours.get(hour), key = `${caller}/${purpose}`;
    bucket.set(key, (bucket.get(key) || 0) + 1);
  }
  snapshot(policy = batchDefaults) {
    const hour = new Date(this.now()).toISOString().slice(0, 13), bucket = this.hours.get(hour) || new Map();
    const byCaller = {}, byPurpose = {}; let total = 0;
    for (const [key, n] of bucket) { const [caller, purpose] = key.split('/'); byCaller[caller] = (byCaller[caller] || 0) + n; byPurpose[key] = n; total += n; }
    const threshold = Math.floor(policy.hourlyBudget * policy.warnFraction);
    return { hour: `${hour}:00Z`, total, byCaller, byPurpose, hourlyBudget: policy.hourlyBudget, warnAt: threshold, over: total > threshold };
  }
}

const backoff = (tries, error) => Math.max(error?.retryAfterMs || 0, Math.min(300000, 5000 * 2 ** Math.min(tries, 6)));
const terminalStates = ['completed', 'canceled'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A request Linear refused as such (HTTP 4xx other than 408 / 429, or a GraphQL validation error): sending the same
 * request again cannot succeed. Network failures, 5xx, rate limits and credential failures are transient.
 */
export const isRejection = error => Number.isInteger(error?.status) && error.status >= 400 && error.status < 500 &&
  ![408, 429].includes(error.status) && error.code !== 'RATE_LIMITED' && error.code !== 'LINEAR_AUTH';

/** Issue id an external op writes to, when known without a read (uuid, cache, or resolved by an earlier check). */
const externalTarget = (item, cache) => {
  const ref = item.op?.issue;
  if (!ref) return null;
  if (UUID.test(ref)) return ref;
  return item.resolvedIssueId || cache?.find(ref)?.id || null;
};
/** The issue an outbox item writes to (per-issue FIFO key); issueCreate has none. */
export function issueKey(item, cache) {
  if (!item.external) return item.issueId || null;
  if (!item.op?.issue) return null;
  return externalTarget(item, cache) || String(item.op.issue).toUpperCase();
}
/**
 * Per-issue FIFO: of the pending items of one issue only the OLDEST may leave, and only once it is due. A newer
 * comment never overtakes an older one that is backing off, failed alone in the last flush, or waits for a state
 * read; one issue's items leave one per flush (an older alias failing while a newer one in the same request
 * succeeds would also break the order).
 */
export function readyItems(outbox, now = Date.now(), cache) {
  const seen = new Set(), out = [];
  for (const item of outbox) {
    if (item.status !== 'pending') continue;
    const key = issueKey(item, cache);
    if (key) { if (seen.has(key)) continue; seen.add(key); }
    if (!item.nextAt || item.nextAt <= now) out.push(item);
  }
  return out;
}

/**
 * Sends every due outbox item whose client supports batchWrite: groups by credential, one check read (workspace,
 * unknown-outcome retries, every state move's live state, refs the cache does not know), then aliased mutations of at
 * most maxPerRequest aliases / maxRequestBytes. `items` are already filtered (readyItems, not superseded).
 * Returns the items it handled (the rest go the legacy way).
 */
export async function flushBatched(runtime, state, items) {
  const policy = batchPolicy(state.settings), groups = new Map();
  for (const item of items) {
    const project = state.settings.projects.find(p => p.id === item.projectId);
    if (!project?.linear) continue;
    let client;
    // One merged request carries several callers' writes: it is counted once, as the dispatcher's.
    try { client = runtime.client(project.linear, { caller: 'dispatcher', purpose: 'write' }); } catch { continue; }
    if (typeof client.batchWrite !== 'function') continue;
    const mapping = linearMapping(project, state.settings), key = syncKey(mapping);
    if (!groups.has(key)) groups.set(key, { client, project, mapping, key, items: [] });
    groups.get(key).items.push(item);
  }
  const handled = [];
  for (const group of groups.values()) {
    handled.push(...group.items);
    await flushGroup(runtime, state, group, policy);
  }
  return handled;
}

async function flushGroup(runtime, state, { client, project, mapping, key, items }, policy) {
  const cache = runtime.linearCache, done = item => item.parts || {}, started = Date.now();
  const settle = async (updates) => runtime.dispatcher.update(s => { for (const [id, fn] of updates) { const entry = s.outbox.find(i => i.id === id); if (entry) fn(entry, s); } }, { durable: true });
  // Terminal after maxTries: a write Linear keeps refusing (or whose issue state stays unknown) stops and shows as
  // a snapshot error instead of retrying forever.
  const retry = (e, message, error) => {
    e.tries++; e.lastError = message;
    if (e.tries >= policy.maxTries) { e.status = 'failed'; e.finishedAt = new Date().toISOString(); delete e.nextAt; }
    else e.nextAt = Date.now() + backoff(e.tries, error);
  };
  // 1. One check read for the whole group. It is always made when a state is about to move (the live state, never a
  // cached one, decides whether a person closed the issue), when an earlier send's outcome is unknown (tries > 0 or
  // the durable attemptAt marker), when an identifier is not cached, and at least hourly for the workspace guard.
  const commentIds = [], issueIds = [], refs = [], needs = new Set();
  for (const item of items) {
    const parts = done(item), unsure = item.tries > 0 || Boolean(item.attemptAt);
    if (item.external) {
      const op = item.op, target = externalTarget(item, cache);
      if (op.kind !== 'issueCreate' && !target) { refs.push(op.issue); needs.add(item.id); }
      if (unsure && op.kind === 'comment' && !parts.comment) { commentIds.push(item.id); needs.add(item.id); }
      if (unsure && op.kind === 'issueCreate' && !parts.create) { issueIds.push(item.id); needs.add(item.id); }
      if (op.kind === 'issueUpdate' && op.input.stateId && target) { issueIds.push(target); needs.add(item.id); }
    } else {
      if (unsure && item.body && !parts.comment) { commentIds.push(item.id); needs.add(item.id); }
      if (item.stateId && !parts.state) { issueIds.push(item.issueId); needs.add(item.id); }
    }
  }
  runtime.linearVerified ||= new Map(); runtime.linearWriteBlocked ||= new Map();
  const verified = runtime.linearVerified.get(key);
  const workspaceKnown = verified && verified.workspaceId === mapping.workspaceId && started - verified.at < policy.workspaceCheckMs;
  let check = { comments: new Set(), issues: new Map(), refs: new Map() };
  if (needs.size || !workspaceKnown) {
    try {
      runtime.usagePurpose(client, 'write-check');
      check = await client.writeCheck({ commentIds, issueIds, refs });
      if (!mapping.workspaceId || check.organizationId !== mapping.workspaceId) {
        throw Object.assign(new Error('Linear 凭据不属于本项目配置的工作区，拒绝写入'), { code: 'WRONG_WORKSPACE' });
      }
      runtime.linearVerified.set(key, { workspaceId: mapping.workspaceId, at: started });
      runtime.linearWriteBlocked.delete(key);
      for (const issue of check.issues.values()) cache.put(issue, undefined, true);
      for (const issue of check.refs?.values() || []) if (issue) cache.put(issue, undefined, true);
    } catch (error) {
      // Without the check nothing whose outcome or guard is unknown may be sent; without a verified workspace nothing
      // at all. Those items back off; the others (workspace verified) still leave.
      const wrong = error.code === 'WRONG_WORKSPACE';
      if (wrong) { runtime.linearVerified.delete(key); runtime.linearWriteBlocked.set(key, `${project.label || project.id}: ${error.message}`); }
      const waiting = wrong || !workspaceKnown ? items : items.filter(i => needs.has(i.id));
      await settle(waiting.map(i => [i.id, entry => { entry.tries++; entry.lastError = wrong ? error.message : 'Linear request failed; retrying without reexecution'; entry.nextAt = Date.now() + backoff(entry.tries, error); }]));
      items = items.filter(i => !waiting.includes(i));
      check = { comments: new Set(), issues: new Map(), refs: new Map() };
    }
  }
  // 2. Build aliases.
  const ops = [], owners = new Map(), early = new Map();
  let botId;
  const mark = (item, fn) => { const list = early.get(item.id) || []; list.push(fn); early.set(item.id, list); };
  for (const item of items) {
    const parts = done(item), n = ops.length;
    if (item.external) {
      const op = item.op;
      let target = null;
      if (op.kind !== 'issueCreate') {
        target = externalTarget(item, cache);
        if (!target) {
          if (!check.refs?.has(op.issue)) continue; // not resolved in this read (over its limit): next flush
          const found = check.refs.get(op.issue);
          if (!found) { mark(item, e => { e.status = 'failed'; e.lastError = `Linear 找不到 ${op.issue}（或本凭据无权访问），不发送`; e.finishedAt = new Date().toISOString(); }); continue; }
          target = found.id;
          mark(item, e => { e.resolvedIssueId = found.id; });
        }
      }
      if (op.kind === 'comment') {
        if (check.comments.has(item.id)) { mark(item, e => { e.parts = { ...e.parts, comment: item.id }; e.result = { commentId: item.id }; }); continue; }
        ops.push({ alias: `x${n}`, kind: 'comment', input: { id: item.id, issueId: target, body: op.body } });
      } else if (op.kind === 'issueCreate') {
        const known = check.issues.get(item.id);
        if (known) { mark(item, e => { e.parts = { ...e.parts, create: true }; e.result = { issueIdentifier: known.identifier, issueId: known.id }; }); continue; }
        const input = { id: item.id, title: op.input.title, ...(op.input.description !== undefined ? { description: op.input.description } : {}) };
        for (const k of ['projectId', 'assigneeId', 'stateId', 'labelIds', 'teamId']) if (op.input[k]) input[k] = op.input[k];
        input.projectId ||= project.linear.projectId;
        input.teamId ||= project.linear.teamId;
        if (op.input.delegateToBot) {
          try { botId ||= (await runtime.botIdentity(project.linear)).id; input.delegateId = botId; }
          catch (error) { mark(item, e => { e.tries++; e.lastError = '机器人身份不可用，无法委派'; e.nextAt = Date.now() + backoff(e.tries, error); }); continue; }
        }
        if (!input.teamId) { mark(item, e => { e.status = 'failed'; e.lastError = 'issueCreate 缺少 teamId'; e.finishedAt = new Date().toISOString(); }); continue; }
        ops.push({ alias: `x${n}`, kind: 'issueCreate', input });
      } else {
        if (op.input.stateId) {
          // Same guard as task reports: an issue a person closed is never moved to another state.
          const live = check.issues.get(target) || check.refs?.get(op.issue);
          const type = live?.state?.type;
          if (!type) { mark(item, e => retry(e, 'Linear 状态未知，等下次检查后再改状态')); continue; }
          if (terminalStates.includes(type) && live.state.id !== op.input.stateId) {
            mark(item, e => { e.status = 'failed'; e.lastError = `工单已被人关闭（${type}），不改回其他状态`; e.finishedAt = new Date().toISOString(); }); continue;
          }
        }
        ops.push({ alias: `x${n}`, kind: 'issueUpdate', id: target, input: op.input });
      }
      owners.set(`x${n}`, { item, part: op.kind === 'comment' ? 'comment' : op.kind === 'issueCreate' ? 'create' : 'update' });
      continue;
    }
    if (item.body && !parts.comment) {
      if (check.comments.has(item.id)) mark(item, e => { e.parts = { ...e.parts, comment: true }; });
      else { const alias = `c${ops.length}`; ops.push({ alias, kind: 'comment', input: { id: item.id, issueId: item.issueId, body: item.body } }); owners.set(alias, { item, part: 'comment' }); }
    }
    if (item.stateId && !parts.state) {
      // The live state from this flush's check read, never a cached one: the issue was closed by a person -> never move it back.
      const type = check.issues.get(item.issueId)?.state?.type;
      if (terminalStates.includes(type)) mark(item, e => { e.parts = { ...e.parts, state: 'skipped' }; });
      else if (type) { const alias = `u${ops.length}`; ops.push({ alias, kind: 'issueUpdate', id: item.issueId, input: { stateId: item.stateId } }); owners.set(alias, { item, part: 'state' }); }
      else mark(item, e => retry(e, 'Linear 状态未知，等下次检查后再改状态'));
    }
  }
  // 3. In-flight marker (durable, before anything is sent): after a crash between the send and the record below,
  // the next attempt always does the check read first instead of trusting Linear to refuse a duplicate id.
  if (ops.length) await settle([...new Set([...owners.values()].map(o => o.item.id))].map(id => [id, e => { e.attemptAt = new Date(started).toISOString(); }]));
  // Chunks of at most maxPerRequest aliases and maxRequestBytes of variables.
  const chunks = [];
  let chunk = [], bytes = 0;
  for (const op of ops) {
    const size = JSON.stringify(op.input).length + 200;
    if (chunk.length && (chunk.length >= policy.maxPerRequest || bytes + size > policy.maxRequestBytes)) { chunks.push(chunk); chunk = []; bytes = 0; }
    chunk.push(op); bytes += size;
  }
  if (chunk.length) chunks.push(chunk);
  const outcomes = new Map();
  let stopped = null;
  const transient = (list, error) => { for (const op of list) outcomes.set(op.alias, { ok: false, error: 'Linear request failed; retrying without reexecution', cause: error }); };
  // A whole chunk Linear refuses (4xx, validation without a path) is bisected until the poison alias is alone; only
  // that alias counts as rejected. A rate limit stops the rest of this flush (its retryAfterMs is honoured).
  const send = async list => {
    if (stopped) return transient(list, stopped);
    try {
      runtime.usagePurpose(client, 'write');
      for (const [alias, value] of await client.batchWrite(list)) outcomes.set(alias, value);
    } catch (error) {
      if (error.code === 'RATE_LIMITED') { stopped = error; return transient(list, error); }
      if (!isRejection(error)) return transient(list, error);
      if (list.length === 1) return outcomes.set(list[0].alias, { ok: false, error: String(error.message || 'Linear rejected the write').slice(0, 200) });
      const half = Math.ceil(list.length / 2);
      await send(list.slice(0, half)); await send(list.slice(half));
    }
  };
  for (const list of chunks) await send(list);
  // 4. Record: per part success; failed parts retry alone with backoff; complete items become sent.
  const updates = new Map();
  for (const [id, fns] of early) updates.set(id, [...fns]);
  for (const [alias, { item, part }] of owners) {
    const out = outcomes.get(alias); if (!out) continue;
    const list = updates.get(item.id) || [];
    if (out.ok) list.push(e => {
      e.parts = { ...e.parts, [part]: true };
      if (part === 'comment' && item.external) e.result = { commentId: out.data?.comment?.id || item.id };
      if (part === 'create') { e.result = { issueIdentifier: out.data?.issue?.identifier, issueId: out.data?.issue?.id }; if (out.data?.issue) runtime.linearCache.put({ ...out.data.issue, title: item.op.input.title, project: { id: item.op.input.projectId || project.linear.projectId }, updatedAt: new Date().toISOString() }, undefined, true); }
      if (part === 'update') { e.result = { issueIdentifier: out.data?.issue?.identifier }; if (out.data?.issue?.id) runtime.linearCache.put({ ...out.data.issue, updatedAt: new Date().toISOString() }, undefined, true); }
      if (part === 'state' && out.data?.issue) runtime.linearCache.put({ ...out.data.issue, id: item.issueId, project: { id: project.linear.projectId }, updatedAt: new Date().toISOString() }, undefined, true);
    });
    else list.push(e => { e.failedPart = part; e.lastError = out.cause ? out.error : `Linear 拒绝写入：${out.error}`; e.rejected = !out.cause; e.failCause = out.cause || null; });
    // The outcome is known (confirmed, or refused as such): the in-flight marker goes; a transport failure keeps it.
    if (out.ok || !out.cause) list.push(e => { if (!e.failedPart || e.rejected) delete e.attemptAt; });
    updates.set(item.id, list);
  }
  await runtime.dispatcher.update(s => {
    for (const [id, fns] of updates) {
      const entry = s.outbox.find(i => i.id === id); if (!entry || entry.status !== 'pending') continue;
      delete entry.failedPart; delete entry.rejected; delete entry.failCause;
      for (const fn of fns) fn(entry, s);
      const cause = entry.failCause; delete entry.failCause;
      if (entry.status !== 'pending') { delete entry.failedPart; delete entry.rejected; continue; }
      const parts = entry.parts || {};
      const complete = entry.external ? Boolean(parts.comment || parts.create || parts.update)
        : (!entry.body || parts.comment) && (!entry.stateId || parts.state);
      if (complete) {
        entry.status = 'sent'; delete entry.lastError; delete entry.nextAt; delete entry.attemptAt; entry.sentAt = new Date().toISOString();
        const task = s.tasks.find(t => t.id === entry.taskId);
        if (!entry.external && !entry.roundReport && task && task.reportVersion === entry.reportVersion && task.status === entry.taskStatus) task.report = 'sent';
      } else if (entry.failedPart) {
        // A write Linear itself rejected stops after maxTries (task reports too); transport failures keep retrying.
        if (entry.rejected) retry(entry, entry.lastError);
        else { entry.tries++; entry.nextAt = Date.now() + backoff(entry.tries, cause); }
      }
      delete entry.failedPart; delete entry.rejected;
    }
  }, { durable: true });
}
