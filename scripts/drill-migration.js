#!/usr/bin/env node
// Migration drill on a read-only copy of a real dispatcher state, with the host's own JSON storage backend
// and domain layer (from the global DSH install). Never touches the source or the DSH home.
//
//   node scripts/drill-migration.js --work <empty temp dir> [--source <agent_dispatcher.json>] [--dsh <@deepseek-ai dir>]
//
// Reports: migration time and sizes, per-task consistency (hot tasks field by field, archived tasks and rounds
// read back), automatic-path decisions before/after, update latency and bytes written, rollback export.
import { copyFile, mkdir, readdir, stat, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { domainSpec, taskDomainSpec } from '../src/plugin.js';
import { openTaskDomain, RecordDomainBackend, TASK_DOMAIN } from '../src/migration.js';
import { ArchiveStore } from '../src/archive.js';
import { archivePlan, archivePolicy, applyArchive } from '../src/archiving.js';
import { TaskStore } from '../src/state-store.js';
import { Dispatcher } from '../src/dispatcher.js';
import { currentTask, attentionFor, roundsOf, hasContinuation, ownCommentIds } from '../src/workflow.js';
import { attention } from '../src/notifications.js';
import { syncGroups } from '../src/linear-sync.js';
import { exportLegacyState } from './export-legacy-state.js';

const args = {};
for (let i = 2; i < process.argv.length; i++) if (process.argv[i].startsWith('--')) args[process.argv[i].slice(2)] = process.argv[++i];
const home = path.resolve(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'));
const source = args.source || path.join(home, 'storages', 'agent_dispatcher.json');
if (!args.work) throw new Error('--work <empty temp dir> is required');
const work = path.resolve(args.work);
if (work.toLowerCase().startsWith(home.toLowerCase())) throw new Error('The drill must not write under the DSH home');
if ((await readdir(work).catch(() => [])).length) throw new Error(`${work} is not empty`);
const npmRoot = () => execFileSync(process.platform === 'win32' ? 'cmd.exe' : 'npm', process.platform === 'win32' ? ['/d', '/c', 'npm root -g'] : ['root', '-g'], { encoding: 'utf8' }).trim();
const dsh = args.dsh || path.join(npmRoot(), '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai');
const load = name => import(pathToFileURL(path.join(dsh, name, 'lib', 'index.js')).href);
const { JsonStorageBackend } = await load('dsh-storage-json');
const { DomainFacility } = await load('dsh-storage-domain');

const storages = path.join(work, 'storages'), directory = path.join(work, 'agent-dispatcher');
await mkdir(storages, { recursive: true });
await copyFile(source, path.join(storages, 'agent_dispatcher.json'));
const MB = n => `${(n / 1048576).toFixed(2)} MB`, ms = n => `${n.toFixed(1)} ms`;
const out = {};
const time = async fn => { const t = performance.now(); const value = await fn(); return [value, performance.now() - t]; };
async function dirSize(dir) {
  let bytes = 0, files = 0;
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) { const s = await dirSize(p); bytes += s.bytes; files += s.files; } else { bytes += (await stat(p)).size; files++; }
  }
  return { bytes, files };
}

function facility() {
  const backend = new JsonStorageBackend(storages);
  const ctx = { storage: { backend: { get: () => backend } }, emit() {}, logger: { warn: m => console.warn(m), error: m => console.error(m) } };
  return { facility: new DomainFacility(ctx, { backend: 'json', routes: {} }), backend };
}

// ---- legacy baseline (what the current version does per update) -----------------------------------------------
const legacy = JSON.parse(await readFile(source, 'utf8')).global;
{
  const [, clone] = await time(() => structuredClone(legacy));
  const copy = structuredClone(legacy);
  const [, equal] = await time(() => isDeepStrictEqual(copy, legacy));
  const [text, serialize] = await time(() => JSON.stringify(legacy));
  out.before = { stateBytes: text.length, tasks: legacy.tasks.length, outbox: legacy.outbox.length,
    perUpdateMs: { structuredCloneTwice: clone * 2, deepEqual: equal, serialize }, bytesPerSave: (await stat(source)).size };
}

// ---- migration with the real backend --------------------------------------------------------------------------
const archive = await new ArchiveStore(path.join(directory, 'archive')).open();
const now = Date.now();
let { facility: f1, backend: b1 } = facility();
const [domain, migrateMs] = await time(() => openTaskDomain({ open: spec => f1.open(spec), spec: taskDomainSpec, legacySpec: domainSpec,
  isFresh: v => isDeepStrictEqual(v, domainSpec.global.initial), backupCandidates: [storages], directory,
  prepare: async s => { await applyArchive(s, archive, archivePlan(s, archivePolicy(s.settings), now, { unstampedOutbox: 'archive' }), now); return s; } }));
out.migration = { ms: migrateMs, marker: domain.global.get().migration };
await domain.close(); await b1.close();
// Rerun on an already migrated domain is a no-op.
({ facility: f1, backend: b1 } = facility());
const [domain2, reopenMs] = await time(() => openTaskDomain({ open: spec => f1.open(spec), spec: taskDomainSpec, legacySpec: domainSpec,
  isFresh: () => false, backupCandidates: [storages], directory, prepare: async () => { throw new Error('must not migrate twice'); } }));
out.reopenMs = reopenMs;
const store = await new TaskStore(new RecordDomainBackend(domain2), { archive }).open();
const state = await store.read();
const onDisk = await dirSize(path.join(storages, TASK_DOMAIN)), archived = await dirSize(path.join(directory, 'archive'));
out.after = { hotTasks: state.tasks.length, hotOutbox: state.outbox.length, hotStateBytes: JSON.stringify(state).length,
  perRecordFiles: onDisk.files, perRecordBytes: onDisk.bytes, archivedTasks: archive.taskIds().length, archivedOutbox: archive.outboxItems().length,
  archiveFiles: archived.files, archiveBytes: archived.bytes,
  backup: (await readdir(storages)).filter(n => n.includes('.bak-')) };

// ---- consistency -------------------------------------------------------------------------------------------
const fields = ['status', 'owner', 'effortArm', 'wait', 'waitProject', 'workItems', 'session', 'pendingRounds', 'pendingComments', 'attempts',
  'previousAttempts', 'outcome', 'summary', 'prompt', 'basePrompt', 'goalPrompt', 'ownerInstructions', 'report', 'reportVersion', 'assessed',
  'autoRounds', 'sessionRounds', 'wakeups', 'reviewWakeups', 'followupSeen', 'resumeWindow', 'events', 'key', 'issue', 'supersededBy', 'continuationOf'];
const mismatches = [], byId = new Map(state.tasks.map(t => [t.id, t]));
let hotChecked = 0, archivedChecked = 0, roundsChecked = 0;
for (const old of legacy.tasks) {
  const hot = byId.get(old.id), now2 = hot || archive.task(old.id);
  if (!now2) { mismatches.push(`${old.id}: missing`); continue; }
  hot ? hotChecked++ : archivedChecked++;
  for (const field of fields) if (!isDeepStrictEqual(now2[field], old[field])) mismatches.push(`${old.issue?.identifier || old.id} ${field}`);
  const rounds = roundsOf(now2, state);
  if (!isDeepStrictEqual(rounds, old.rounds || [])) mismatches.push(`${old.issue?.identifier || old.id} rounds`); else roundsChecked += rounds.length;
  const { rounds: _a, archivedRounds: _b, ...restNew } = now2, { rounds: _c, ...restOld } = old;
  if (!isDeepStrictEqual(restNew, restOld)) mismatches.push(`${old.issue?.identifier || old.id} other fields`);
}
const legacyCurrent = legacy.tasks.filter(t => currentTask(t, legacy));
const decisions = s => ({
  current: s.tasks.filter(t => currentTask(t, s)).map(t => t.id).sort(),
  attention: s.tasks.map(t => [t.id, attentionFor(t, s)]).filter(([, a]) => a).sort(),
  notifications: [...attention(s, { projectIds: s.settings.projects.map(p => p.id), completed: true }).keys()].sort(),
  continued: s.tasks.filter(t => currentTask(t, s) && hasContinuation(t, s)).map(t => t.id),
  syncWaits: syncGroups(s).map(g => [g.key, g.waits.map(t => t.id)]),
  active: s.tasks.filter(t => !['review', 'failed', 'exhausted', 'stopped', 'accepted', 'blocked', 'decision', 'stalled', 'needs_result'].includes(t.status)).map(t => t.id).sort()
});
const [d0, d1] = [decisions(legacy), decisions(state)];
// A current task that was archived (accepted/stopped, quiet) is no longer listed; every other decision must match.
const archivedCurrent = d0.current.filter(id => !byId.has(id));
d0.current = d0.current.filter(id => byId.has(id));
const decisionDiffs = Object.keys(d0).filter(k => !isDeepStrictEqual(d0[k], d1[k]));
const ownBefore = new Set(legacy.outbox.map(i => i.id)), ownAfter = new Set(ownCommentIds(state));
out.consistency = { legacyTasks: legacy.tasks.length, hotChecked, archivedChecked, roundsChecked, fieldMismatches: mismatches,
  activeTasks: d0.active.length, currentTasks: legacyCurrent.length,
  archivedCurrent: archivedCurrent.map(id => { const t = legacy.tasks.find(x => x.id === id); return `${t.issue?.identifier || id} ${t.status} ${t.events?.at(-1)?.at}`; }),
  decisionDiffs,
  ownCommentIdsEqual: ownBefore.size === ownAfter.size && [...ownBefore].every(id => ownAfter.has(id)) };

// ---- update cost ---------------------------------------------------------------------------------------------
const dispatcher = new Dispatcher({ store, adapters: {} });
let written = 0;
const write = store.backend.write.bind(store.backend);
store.backend.write = async (batch, cb) => { written += batch.puts.reduce((n, p) => n + p.text.length, 0) + (batch.global?.length || 0); return write(batch, cb); };
const median = list => [...list].sort((a, b) => a - b)[list.length >> 1];
const noop = [];
for (let i = 0; i < 20; i++) noop.push((await time(() => dispatcher.update(() => {})))[1]);
const [, readMs] = await time(() => store.read());
out.update = { noopMedianMs: median(noop), readMs, oneTask: [] };
// The largest hot task and a typical running one: one field changed, the update persisted.
const running = state.tasks.filter(t => t.status === 'running').sort((a, b) => JSON.stringify(a).length - JSON.stringify(b).length);
const largest = [...state.tasks].sort((a, b) => JSON.stringify(b).length - JSON.stringify(a).length)[0];
for (const target of [running[running.length >> 1], largest].filter(Boolean)) {
  const samples = []; written = 0;
  for (let i = 0; i < 20; i++) samples.push((await time(() => dispatcher.update(s => { s.tasks.find(t => t.id === target.id).drillTouch = i; })))[1]);
  out.update.oneTask.push({ task: `${target.issue?.identifier || target.id} (${target.status})`, medianMs: median(samples), jsonBytesWritten: written / 20,
    fileBytes: (await stat(path.join(storages, TASK_DOMAIN, 'tasks', `${target.id}.json`))).size });
  await dispatcher.update(s => { delete s.tasks.find(t => t.id === target.id).drillTouch; });
}
await domain2.close(); await b1.close();

// ---- rollback export -------------------------------------------------------------------------------------------
const exported = await exportLegacyState({ storage: storages, archive: path.join(directory, 'archive') });
const stamped = new Set(legacy.outbox.filter(i => !i.finishedAt).map(i => i.id));
const exportDiffs = Object.keys({ ...legacy, ...exported }).filter(k => !isDeepStrictEqual(exported[k], legacy[k]));
out.rollback = { identical: isDeepStrictEqual(exported, legacy), differingKeys: exportDiffs,
  taskOrderEqual: isDeepStrictEqual(exported.tasks.map(t => t.id), legacy.tasks.map(t => t.id)), stampedLegacyOutbox: stamped.size };
console.log(JSON.stringify(out, (k, v) => typeof v === 'number' && !Number.isInteger(v) ? Math.round(v * 10) / 10 : v, 2));
