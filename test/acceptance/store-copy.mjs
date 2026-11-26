// Acceptance (g): open a COPY of the real persisted store with a given code tree and run several real host cycles with
// a synthetic Linear transport (legacy mode, no new issues or comments) and a fake executor; print a JSON summary.
//
//   node test/acceptance/store-copy.mjs --run --code <code root> --copy <copied agent_dispatcher_v2 dir> \
//        --archive <copied archive dir> [--cycles 6]
//
// The caller copies ~/.dsh/storages/agent_dispatcher_v2 (and the archive) first; this script never opens the original.
// It refuses any path under ~/.dsh. Imported by `node --test` it does nothing (no tests, no I/O).
import os from 'node:os';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { FakeDomain } from '../fake-domain.js';

const summary = t => ({ status: t.status, hold: t.hold?.by || null, attempts: (t.attempts || []).length, wakeups: t.wakeups || 0,
  reviewWakeups: t.reviewWakeups || 0, pendingStop: t.pendingStop || null, wait: t.wait?.status || null, events: (t.events || []).length });
const reply = data => ({ status: 200, ok: true, headers: new Map(), json: async () => ({ data }) });
const pageInfo = { hasNextPage: false, endCursor: null };
const noRelations = { relations: { nodes: [], pageInfo }, inverseRelations: { nodes: [], pageInfo } };

export async function runCopy({ code, copy, archive, cycles = 6 }) {
  const dsh = path.resolve(os.homedir(), '.dsh').toLowerCase();
  for (const p of [copy, archive]) if (path.resolve(p).toLowerCase().startsWith(dsh)) throw new Error(`refusing to open a path under ~/.dsh: ${p}`);
  globalThis.fetch = async url => { throw new Error(`network forbidden: ${url}`); };
  const imp = rel => import(pathToFileURL(path.join(code, rel)).href);
  const [{ Runtime }, { LinearClient }, { TaskStore }, { ArchiveStore }, { RecordDomainBackend }, { AdapterRegistry }] = await Promise.all(
    ['src/runtime.js', 'src/linear.js', 'src/state-store.js', 'src/archive.js', 'src/migration.js', 'src/adapters/registry.js'].map(imp));
  const domain = new FakeDomain({ directory: copy });
  const store = await new TaskStore(new RecordDomainBackend(domain), { archive: await new ArchiveStore(archive).open() }).open();
  const initial = await store.read();
  const before = Object.fromEntries(initial.tasks.map(t => [t.id, summary(t)]));
  const projects = initial.settings.projects.filter(p => p.linear?.enabled);
  const workspaceId = projects[0]?.linear.workspaceId;
  const projectOf = new Map(initial.tasks.map(t => [t.issue?.id, initial.settings.projects.find(p => p.id === t.projectId)?.linear]));
  const ops = {}, writes = [], unknown = [], starts = [], judged = [];
  const synthetic = id => { const l = projectOf.get(id) || projects[0].linear;
    return { id, identifier: id, title: '', url: '', updatedAt: '2026-01-01T00:00:00.000Z', project: { id: l.projectId }, assignee: { id: l.assigneeId },
      state: { id: l.activeStateId || 'active', type: 'started' }, parent: null, archivedAt: null, ...noRelations,
      comments: { nodes: [], pageInfo }, children: { nodes: [] } }; };
  const fetcher = async (url, init) => {
    if (url !== 'https://api.linear.app/graphql') throw new Error(`unexpected url ${url}`);
    const { query, variables: v } = JSON.parse(init.body);
    const op = query.includes('commentCreate') ? 'commentCreate' : query.includes('issueUpdate') ? 'issueUpdate'
      : /organization \{ id \} \}\s*$/.test(query.trim()) && !query.includes('issue') ? 'organization'
      : query.includes('issues(filter:') ? (v.filter?.id ? 'watched' : 'intake') : query.includes('comments(filter:') ? 'comments'
      : query.includes('source:issue(') ? 'issueContext' : query.includes('children(first:50)') ? 'focusContext' : query.includes('issue(id:$id)') ? 'issue' : 'other';
    ops[op] = (ops[op] || 0) + 1;
    if (op === 'commentCreate') { writes.push({ kind: 'comment', issueId: v.input.issueId }); return reply({ commentCreate: { success: true } }); }
    if (op === 'issueUpdate') { writes.push({ kind: 'state', issueId: v.id, stateId: v.input.stateId }); return reply({ issueUpdate: { success: true } }); }
    if (query.includes('viewer')) return reply({ viewer: { id: 'legacy', name: 'legacy', app: false }, organization: { id: workspaceId } });
    if (op === 'organization') return reply({ organization: { id: workspaceId } });
    if (op === 'intake') return reply({ issues: { nodes: [], pageInfo } });
    if (op === 'watched') return reply({ issues: { nodes: (v.filter.id.in || []).map(synthetic), pageInfo } });
    if (op === 'comments') return reply({ comments: { nodes: [], pageInfo } });
    if (op === 'issueContext') return reply({ source: synthetic(v.parent), target: synthetic(v.target), users: { nodes: [] } });
    if (op === 'focusContext' || op === 'issue') return reply({ issue: synthetic(v.id) });
    unknown.push(query.slice(0, 160)); return { status: 400, ok: false, headers: new Map(), json: async () => ({ errors: [{ message: 'unknown' }] }) };
  };
  const adapter = { start: async input => { starts.push(input.task.id); return { status: 'running', sessionId: `fake-${input.task.id}` }; },
    reconcile: async ({ task } = {}) => ({ status: task?.status === 'running' ? 'running' : 'unknown' }),
    stop: async () => ({ status: 'unknown' }), health: async () => ({ available: true }) };
  const registry = new AdapterRegistry();
  for (const type of ['codex', 'claude', 'dsh']) registry.register(type, () => adapter);
  const env = Object.fromEntries(projects.map(p => [p.linear.tokenEnv, 'synthetic-legacy-key']));
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dispatch-copy-run-'));
  const runtime = await new Runtime({ store, directory, env, registry, commentSweepMs: 0, linearFetch: fetcher,
    linearFactory: token => new LinearClient(token, fetcher), focusJudge: async input => { judged.push(input?.candidate?.identifier); return { verdict: 'unrelated', reason: 'x' }; } }).init();
  const afterInit = await store.read();
  const errors = new Set();
  for (let i = 0; i < cycles; i++) {
    await runtime.dispatcher.update(s => { for (const k of Object.keys(s.linearSync || {})) { if (s.linearSync[k]) { s.linearSync[k].nextAt = 0; delete s.linearSync[k].retryAt; } } });
    runtime.reviewCheckedAt?.clear?.();
    await runtime.cycleBody();
    for (const e of runtime.errors || []) errors.add(e);
  }
  await runtime.notifications?.pending?.catch?.(() => {});
  const final = await store.read();
  const snap = await runtime.snapshot();
  const after = Object.fromEntries(final.tasks.map(t => [t.id, summary(t)]));
  const changed = Object.keys({ ...before, ...after }).filter(id => JSON.stringify(before[id]) !== JSON.stringify(after[id]))
    .map(id => ({ id, issue: (final.tasks.find(t => t.id === id) || initial.tasks.find(t => t.id === id))?.issue?.identifier, before: before[id] || null, after: after[id] || null }));
  const statusHist = ts => ts.reduce((h, t) => (h[t.status] = (h[t.status] || 0) + 1, h), {});
  return {
    code, cycles, tasks: final.tasks.length, statusBefore: statusHist(initial.tasks), statusAfter: statusHist(final.tasks),
    heldBefore: initial.tasks.filter(t => t.hold).length, heldAfterInit: afterInit.tasks.filter(t => t.hold).length, heldAfter: final.tasks.filter(t => t.hold).length,
    focus: Boolean(final.focus?.issues?.length), settingsLinear: Boolean(final.settings.linear), drain: Boolean(final.drain?.on),
    unknownSettingKeys: snap.settingsUnknownKeys ?? null, starts, judged, ops, writes: writes.length, unknown, errors: [...errors],
    outbox: final.outbox.reduce((h, o) => (h[o.status] = (h[o.status] || 0) + 1, h), {}), changed
  };
}

const args = process.argv.slice(2);
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) && args.includes('--run')) {
  const opt = k => args[args.indexOf(k) + 1];
  runCopy({ code: path.resolve(opt('--code')), copy: path.resolve(opt('--copy')), archive: path.resolve(opt('--archive')), cycles: Number(opt('--cycles') || 6) })
    .then(r => { process.stdout.write(`${JSON.stringify(r)}\n`); process.exit(0); }, e => { process.stderr.write(`${e.stack}\n`); process.exit(1); });
}
