#!/usr/bin/env node
// Migration helper for switching a project to bot (delegate) intake: lists the project's in-flight issues
// (tasks not in a terminal status) that must be delegated to the bot before their next round can start
// (in delegate mode the pre-start recheck only admits issues whose delegate is the bot).
//
//   node scripts/delegate-migration.mjs --state <file> --project <local project id> --bot <bot user id>
//        [--token-env NAME] [--apply --i-understand]
//
// --state       dispatcher state as JSON ({ settings, tasks }): the legacy export (scripts/export-legacy-state.js)
//               or a saved snapshot. Read only.
// --token-env   NAME of an env var holding a Linear API key (the owner's): with it the dry run also reads each
//               issue's current delegate (read-only GraphQL). Without it the plan comes from local state only.
// --apply       OWNER-RUN ONLY. Sets delegate = bot on the listed issues (issueUpdate). Refused unless
//               --i-understand is given as well and --token-env is set. Never run by the dispatcher or an agent.
//
// Default is a dry run that prints the plan and changes nothing.
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { terminal } from '../src/states.js';
import { LinearClient } from '../src/linear.js';

/** In-flight issues of one local project, one row per Linear issue. */
export function planMigration(state, projectId) {
  const project = state.settings?.projects?.find(p => p.id === projectId);
  if (!project?.linear) throw new Error(`project ${projectId} has no Linear mapping`);
  const rows = new Map();
  for (const task of state.tasks || []) {
    if (task.projectId !== projectId || !task.issue?.id || terminal.has(task.status) || task.stub) continue;
    const row = rows.get(task.issue.id) || { issueId: task.issue.id, identifier: task.issue.identifier || task.issue.id, tasks: [] };
    row.tasks.push({ id: task.id, status: task.status });
    rows.set(task.issue.id, row);
  }
  return { projectId, linearProjectId: project.linear.projectId, issues: [...rows.values()].sort((a, b) => a.identifier.localeCompare(b.identifier, 'en', { numeric: true })) };
}

/** Marks each planned issue with its current delegate (read only). transport(query, variables) -> data. */
export async function inspectDelegates(plan, botId, transport) {
  for (const row of plan.issues) {
    const data = await transport('query($id:String!) { issue(id:$id) { id delegate { id } project { id } } }', { id: row.issueId });
    row.delegateId = data?.issue?.delegate?.id || null;
    row.outsideProject = data?.issue?.project?.id !== plan.linearProjectId;
    row.action = row.outsideProject ? 'skip (outside mapped project)' : row.delegateId === botId ? 'already delegated' : 'delegate to bot';
  }
  return plan;
}

/** OWNER-RUN ONLY: delegates the planned issues to the bot. Requires { iUnderstand: true }. */
export async function applyMigration(plan, botId, transport, { iUnderstand = false } = {}) {
  if (!iUnderstand) throw new Error('--apply needs --i-understand (owner-run only)');
  const done = [];
  for (const row of plan.issues) {
    if (row.action && row.action !== 'delegate to bot') continue;
    const data = await transport('mutation($id:String!, $input:IssueUpdateInput!) { issueUpdate(id:$id, input:$input) { success } }',
      { id: row.issueId, input: { delegateId: botId } });
    if (!data?.issueUpdate?.success) throw new Error(`delegation of ${row.identifier} was not confirmed`);
    done.push(row.identifier);
  }
  return done;
}

export function formatPlan(plan, botId) {
  const lines = [`project ${plan.projectId} (Linear ${plan.linearProjectId}) -> bot ${botId}`,
    `${plan.issues.length} in-flight issue(s):`];
  for (const row of plan.issues) lines.push(`  ${row.identifier}  tasks: ${row.tasks.map(t => `${t.id.slice(0, 8)}:${t.status}`).join(', ')}${row.action ? `  -> ${row.action}` : ''}`);
  return lines.join('\n');
}

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply' || a === '--i-understand' || a === '--dry-run') out[a.slice(2)] = true;
    else if (a.startsWith('--')) out[a.slice(2)] = argv[++i];
  }
  return out;
}

export async function main(argv = process.argv.slice(2), { env = process.env, log = console.log, transportFor } = {}) {
  const o = args(argv);
  if (!o.state || !o.project || !o.bot) throw new Error('usage: --state <file> --project <id> --bot <bot user id> [--token-env NAME] [--apply --i-understand]');
  if (o['token-env'] && !/^[A-Z][A-Z0-9_]{1,159}$/.test(o['token-env'])) throw new Error('--token-env takes an env var NAME, not a key');
  const state = JSON.parse(await readFile(o.state, 'utf8'));
  const plan = planMigration(state.record || state, o.project);
  let transport = null;
  if (o['token-env']) {
    if (!env[o['token-env']]) throw new Error(`env var ${o['token-env']} is not set`);
    transport = transportFor ? transportFor(env[o['token-env']]) : (() => { const c = new LinearClient(env[o['token-env']]); return (q, v) => c.query(q, v); })();
    await inspectDelegates(plan, o.bot, transport);
  }
  log(formatPlan(plan, o.bot));
  if (!o.apply) { log('dry run: nothing changed'); return { plan, applied: [] }; }
  if (!o['i-understand']) throw new Error('--apply needs --i-understand (owner-run only)');
  if (!transport) throw new Error('--apply needs --token-env');
  const applied = await applyMigration(plan, o.bot, transport, { iUnderstand: true });
  log(`delegated ${applied.length}: ${applied.join(', ')}`);
  return { plan, applied };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href)
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
