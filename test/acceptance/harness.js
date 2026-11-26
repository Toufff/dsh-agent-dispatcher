// Acceptance harness: the REAL Runtime (all cycle phases), the production-shaped TaskStore over a per-record domain in a temp directory, the real LinearClient
// over a synthetic in-memory Linear world (no network: global fetch is replaced and any non-Linear URL throws), and a
// scriptable fake executor registered for every executor type. Nothing here reads or writes a production store.
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { TaskStore } from '../../src/state-store.js';
import { ArchiveStore } from '../../src/archive.js';
import { openTaskDomain, RecordDomainBackend, TASK_DOMAIN } from '../../src/migration.js';
import { FakeDomain } from '../fake-domain.js';
import { initialState } from '../../src/config.js';
import { Runtime } from '../../src/runtime.js';
import { LinearClient } from '../../src/linear.js';
import { TOKEN_URL, GRAPHQL_URL } from '../../src/linear-auth.js';
import { AdapterRegistry } from '../../src/adapters/registry.js';
import { workItems } from '../workflow-fixtures.js';

// Hard guard: the acceptance run must never touch the network.
const realFetch = globalThis.fetch;
export function forbidNetwork() { globalThis.fetch = async url => { throw new Error(`network forbidden in acceptance: ${url}`); }; }
export function restoreNetwork() { globalThis.fetch = realFetch; }

export const result = (status, extra = {}) => `<dispatch-result>${JSON.stringify({ status, workItems: status === 'blocked'
  ? [{ id: 'goal', title: '等数据', status: 'blocked', dependsOn: [], action: '', evidence: [], blocker: { kind: 'external', owner: 'touf', reason: '数据快照未到位', resumeWhen: '数据补齐' } }]
  : workItems(status), evidence: ['ok'], remaining: status === 'complete' ? [] : ['x'], next: '', progress: status,
  blockers: status === 'blocked' ? [{ owner: 'touf', reason: '数据快照未到位', resumeWhen: '数据补齐' }] : [], ...extra })}</dispatch-result>`;
export const DONE = result('complete'), BLOCKED = result('blocked');

const reply = (status, json) => ({ status, ok: status >= 200 && status < 300, headers: new Map(), json: async () => json });
const pageInfo = { hasNextPage: false, endCursor: null };
const noRelations = { relations: { nodes: [], pageInfo }, inverseRelations: { nodes: [], pageInfo } };
const get = (obj, key) => obj == null ? undefined : obj[key];
/** Minimal Linear filter evaluator: and/or, nested objects, eq / in / null / gte / lte. */
export function matches(obj, filter) {
  for (const [key, cond] of Object.entries(filter || {})) {
    if (key === 'or') { if (!cond.some(c => matches(obj, c))) return false; continue; }
    if (key === 'and') { if (!cond.every(c => matches(obj, c))) return false; continue; }
    if (key === 'eq') { if (obj !== cond) return false; continue; }
    if (key === 'in') { if (!cond.includes(obj)) return false; continue; }
    if (key === 'null') { if ((obj == null) !== cond) return false; continue; }
    if (key === 'gte') { if (!(obj >= cond)) return false; continue; }
    if (key === 'lte') { if (!(obj <= cond)) return false; continue; }
    if (!matches(get(obj, key), cond)) return false;
  }
  return true;
}

/** A synthetic Linear workspace. Authors: the bearer token belongs to the bot; the personal key to `legacyUser`. */
export class FakeLinear {
  constructor({ workspaceId = 'w', botId = 'bot', legacyUser = 'touf' } = {}) {
    Object.assign(this, { workspaceId, botId, legacyUser, issues: new Map(), comments: [], calls: [], unknown: [], writes: [], tokens: 0 });
    this.fetch = this.fetch.bind(this);
  }
  issue(id, fields = {}) {
    const now = new Date().toISOString();
    const issue = { id, identifier: fields.identifier || id.toUpperCase(), title: fields.title || id, description: fields.description || '',
      url: `https://linear.app/example/issue/${id}`, updatedAt: now, project: { id: 'lp' }, assignee: null, delegate: null,
      state: { id: 'todo', type: 'unstarted' }, parent: null, children: [], ...fields };
    this.issues.set(id, issue); return issue;
  }
  touch(id, fields = {}) { Object.assign(this.issues.get(id), fields, { updatedAt: new Date().toISOString() }); }
  comment(issueId, author, body, at = new Date().toISOString()) {
    const c = { id: `c${this.comments.length + 1}-${author}`, body, createdAt: at, updatedAt: at, user: { id: author }, issueId };
    this.comments.push(c); return c;
  }
  view(issue) {
    return { ...issue, children: { nodes: issue.children.map(id => ({ identifier: this.issues.get(id)?.identifier || id })) }, ...noRelations,
      parent: issue.parent ? { id: issue.parent, identifier: this.issues.get(issue.parent)?.identifier } : null };
  }
  commentView(c) { return { ...c, issue: { id: c.issueId, project: this.issues.get(c.issueId)?.project } }; }
  async fetch(url, init) {
    if (url === TOKEN_URL) { this.tokens++; return reply(200, { access_token: `bot-token-${this.tokens}`, token_type: 'Bearer', expires_in: 2591999 }); }
    assert.equal(url, GRAPHQL_URL, 'only the fixed Linear endpoint may be called');
    const { query, variables: v } = JSON.parse(init.body), auth = init.headers.Authorization;
    const author = String(auth).startsWith('Bearer ') ? this.botId : this.legacyUser;
    this.calls.push({ auth, query: query.replace(/\s+/g, ' ').slice(0, 120) });
    const org = { id: this.workspaceId, name: 'Synthetic' };
    let data;
    if (query.includes('viewer')) data = { viewer: { id: author, name: author === this.botId ? 'TomorrowNeverKnows' : 'Touf', app: author === this.botId }, organization: org,
      projects: { nodes: [], pageInfo }, users: { nodes: [], pageInfo }, workflowStates: { nodes: [], pageInfo } };
    else if (query.includes('commentCreate')) {
      const { id, issueId, body } = v.input;
      this.writes.push({ kind: 'comment', id, issueId, body, auth, author });
      if (!this.comments.some(c => c.id === id)) this.comments.push({ id, body, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), user: { id: author }, issueId });
      data = { commentCreate: { success: true } };
    } else if (query.includes('issueUpdate')) {
      this.writes.push({ kind: 'state', issueId: v.id, stateId: v.input.stateId, auth, author });
      this.touch(v.id, { state: { id: v.input.stateId, type: v.input.stateId === 'review' ? 'started' : 'started' } });
      data = { issueUpdate: { success: true } };
    } else if (/^query \{ organization \{ id \} \}$/.test(query.trim())) data = { organization: org };
    else if (query.includes('issues(filter:')) {
      const nodes = [...this.issues.values()].filter(i => matches(i, v.filter)).map(i => this.view(i));
      data = { issues: { nodes, pageInfo } };
    } else if (query.includes('comments(filter:')) {
      const nodes = this.comments.map(c => this.commentView(c)).filter(c => matches(c, v.filter));
      data = { comments: { nodes, pageInfo } };
    } else if (query.includes('source:issue(')) {
      const s = this.issues.get(v.parent), t = this.issues.get(v.target);
      data = { source: s && this.view(s), target: t && this.view(t), users: { nodes: [] } };
    } else if (query.includes('children(first:50)')) {
      const i = this.issues.get(v.id) || [...this.issues.values()].find(x => x.identifier === v.id);
      data = { issue: i ? { ...this.view(i), comments: { nodes: this.comments.filter(c => c.issueId === i.id).slice(-15) } } : null };
    } else if (query.includes('issue(id:$id)') && query.includes('comments(first:100')) {
      const i = this.issues.get(v.id);
      data = { issue: i && { ...this.view(i), comments: { nodes: this.comments.filter(c => c.issueId === v.id), pageInfo } } };
    } else if (query.includes('issue(id:$id)')) {
      const i = this.issues.get(v.id);
      data = { issue: i ? this.view(i) : null };
    } else { this.unknown.push(query.slice(0, 200)); return reply(400, { errors: [{ message: 'unknown synthetic operation' }] }); }
    return reply(200, { data });
  }
}

/** Scriptable executor. plan.get(identifier) = queue of 'done' | 'blocked' | 'run'; running turns end via finish(). */
export class FakeExecutor {
  constructor() { this.starts = []; this.plan = new Map(); this.live = new Map(); this.stopReply = 'stopped'; this.stops = 0; this.reconcileAll = null; }
  script(identifier, ...modes) { this.plan.set(identifier, [...(this.plan.get(identifier) || []), ...modes]); }
  finish(identifier, summary = DONE) { this.live.set(identifier, { status: 'review', summary }); }
  interrupt(identifier) { this.live.set(identifier, { status: 'interrupted', reason: 'host restarted' }); }
  started(identifier) { return this.starts.filter(s => s.identifier === identifier).length; }
  adapter() {
    return {
      start: async input => {
        const identifier = input.task.issue?.identifier || input.task.id;
        this.starts.push({ identifier, prompt: input.task.prompt, taskId: input.task.id });
        const mode = this.plan.get(identifier)?.shift() || 'done';
        if (mode === 'run') { this.live.set(identifier, { status: 'running' }); return { status: 'running', sessionId: `s-${identifier}` }; }
        return { status: 'review', summary: mode === 'blocked' ? BLOCKED : DONE, sessionId: `s-${identifier}` };
      },
      reconcile: async ({ task }) => this.reconcileAll ? this.reconcileAll(task) : (this.live.get(task.issue?.identifier) || { status: 'running' }),
      stop: async () => { this.stops++; return { status: this.stopReply }; },
      health: async () => ({ available: true })
    };
  }
  registry() {
    const registry = new AdapterRegistry();
    for (const type of ['codex', 'claude', 'dsh']) registry.register(type, () => this.adapter());
    return registry;
  }
}

export const project = (extra = {}, linear = {}, followup = {}) => ({ id: 'p', label: 'Acceptance', cwd: process.cwd(), maxConcurrent: 6,
  linear: { enabled: true, tokenEnv: 'ACCEPT_TOKEN', workspaceId: 'w', projectId: 'lp', assigneeId: 'touf', readyStateId: 'todo',
    activeStateId: 'active', reviewStateId: 'review', round: '1', since: '2026-01-01T00:00:00.000Z', ...linear },
  followup: { enabled: true, commentAuthorIds: ['peer', 'touf'], maxWakeups: 8, reviewComments: true, trustReceiverComments: true, ...followup }, ...extra });

export const ENV = { ACCEPT_TOKEN: 'synthetic-personal-key', TNK_ID: 'synthetic-client-id', TNK_SECRET: 'synthetic-client-secret' };
export const botLinear = (extra = {}) => ({ credentials: [{ id: 'tnk', mode: 'clientCredentials', clientIdEnv: 'TNK_ID', clientSecretEnv: 'TNK_SECRET',
  scope: 'read,write,app:assignable,app:mentionable', botUserId: 'bot' }], projects: [{ projectId: 'p', credential: 'tnk', intake: { by: 'delegate' }, ...extra }] });

/**
 * Production-shaped store: TaskStore over the per-record domain backend (as src/plugin.js), persisted as the json
 * backend's files in a temp directory. A restart re-reads those files into a new domain, store and Runtime.
 */
export async function openStore(directory, seed) {
  const archive = await new ArchiveStore(path.join(directory, 'archive')).open();
  const domains = { agent_dispatcher: new FakeDomain({ initial: seed, tables: [] }), [TASK_DOMAIN]: new FakeDomain({ directory: path.join(directory, TASK_DOMAIN) }) };
  const domain = await openTaskDomain({ open: async spec => domains[spec.name], spec: { name: TASK_DOMAIN }, legacySpec: { name: 'agent_dispatcher' },
    isFresh: () => false, backupCandidates: [], directory, prepare: async s => s });
  return new TaskStore(new RecordDomainBackend(domain), { archive }).open();
}
/** A world = temp store + runtime that can be restarted (store reopened from disk, new Runtime). */
export async function world({ settings = s => s, focusJudge, env = ENV, linear = new FakeLinear(), executor = new FakeExecutor() } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dispatch-accept-'));
  const state = initialState(); state.paused = false; state.settings.concurrency = 6;
  state.settings.executors = [{ id: 'codex', type: 'codex', label: 'Fake executor', command: 'codex', args: [], sandbox: 'read-only', enabled: true }];
  state.settings.projects = [project()];
  state.settings = settings(state.settings) || state.settings;
  let store = await openStore(directory, state);
  const w = { directory, linear, executor, runtime: null, judged: [] };
  w.boot = async () => {
    w.runtime = await new Runtime({ store, directory, env, commentSweepMs: 0, registry: executor.registry(), linearFetch: linear.fetch,
      linearFactory: token => new LinearClient(token, linear.fetch),
      focusJudge: async input => { w.judged.push(input.candidate.identifier); return focusJudge ? focusJudge(input) : { verdict: 'uncertain', reason: 'stub' }; } }).init();
    return w.runtime;
  };
  w.restart = async () => { await w.runtime.notifications.pending?.catch(() => {}); store = await openStore(directory, null); return w.boot(); };
  /** One full host cycle (the real cycleBody), with the per-task / per-group read throttles expired as if time passed. */
  w.cycle = async (n = 1) => {
    for (let i = 0; i < n; i++) {
      await w.runtime.dispatcher.update(s => { for (const k of Object.keys(s.linearSync || {})) { s.linearSync[k].nextAt = 0; delete s.linearSync[k].retryAt; } });
      w.runtime.reviewCheckedAt?.clear();
      await w.runtime.cycleBody();
      await w.runtime.focusJudging;
    }
    return w.snap();
  };
  w.snap = () => w.runtime.snapshot();
  w.tasks = async identifier => (await w.snap()).tasks.filter(t => t.issue?.identifier === identifier);
  w.last = async identifier => (await w.tasks(identifier)).at(-1);
  w.close = async () => { await w.runtime.notifications.pending?.catch(() => {}); };
  await w.boot();
  return w;
}
export const sleep = ms => new Promise(r => setTimeout(r, ms));
