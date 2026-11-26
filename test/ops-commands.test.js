// Ops command surface (refactor B2/B6): clear-resume, explain, drain/undrain, and effective limits in the snapshot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { MemoryStore } from '../src/dispatcher.js';
import { initialState } from '../src/config.js';
import { Runtime } from '../src/runtime.js';
import { remote } from '../src/remote.js';
import { workItems } from './workflow-fixtures.js';

const done = `<dispatch-result>${JSON.stringify({ status: 'complete', workItems: workItems('complete'), evidence: ['ok'], remaining: [], next: '', progress: 'done', blockers: [] })}</dispatch-result>`;

async function fixture({ start, issues = () => [], followup = { enabled: true, commentAuthorIds: ['peer'], maxAutoRounds: 200 } } = {}) {
  const store = new MemoryStore(), state = initialState();
  state.paused = false;
  state.settings.projects = [{ id: 'p', label: 'Example', cwd: process.cwd(),
    linear: { enabled: true, tokenEnv: 'TEST_TOKEN', workspaceId: 'w', assigneeId: 'me', round: '1', reviewStateId: 'review', readyStateId: 'ready', projectId: 'lp', since: '2026-01-01T00:00:00.000Z' }, followup }];
  await store.save(state);
  const runtime = await new Runtime({ store, directory: os.tmpdir(), env: { TEST_TOKEN: 'synthetic' }, linearFactory: () => ({
    eligible: async () => ({}), activity: async () => ({ comments: [] }), issues: async () => issues(), report: async () => {} }) }).init();
  const starts = [];
  runtime.adapters.codex = { start: async input => { starts.push(input); return start ? start(input) : { status: 'review', summary: done, sessionId: 's' }; },
    reconcile: async () => ({ status: 'running' }), stop: async () => ({ status: 'stopped' }) };
  return { runtime, starts };
}
const submit = (runtime, n = 1) => runtime.submit({ projectId: 'p', prompt: 'Work', issue: { id: `issue${n}`, identifier: `EX-${n}` }, source: `w/issue${n}` });

test('remote schema accepts the ops commands', () => {
  const schema = remote.methods['agentDispatcher/command'].parameters[0].codec.create();
  assert.equal(schema.safeParse({ action: 'bogus' }).success, false);
  for (const request of [{ action: 'explain', id: 'x' }, { action: 'clear-resume', id: 'x', expiry: true }, { action: 'drain', reason: 'restart' },
    { action: 'undrain' }, { action: 'unhold', id: 'x' }, { action: 'stop', id: 'x', reason: 'wrong direction' }])
    assert.ok(schema.safeParse(request).success, JSON.stringify(request));
});

test('clear-resume releases a queue window stuck in the future (3.3), audited', async () => {
  const { runtime, starts } = await fixture();
  const id = await submit(runtime);
  const notBefore = new Date(Date.now() + 86400e3).toISOString();
  await runtime.dispatcher.update(s => { s.tasks[0].resumeWindow = { notBefore }; });
  await runtime.dispatcher.tick();
  assert.equal(starts.length, 0);
  const why = await runtime.command({ action: 'explain', id });
  assert.equal(why.runnable.runnableNow, false);
  assert.match(why.runnable.reasons.join(' '), /queue window opens/);
  await runtime.command({ action: 'clear-resume', id });
  const t = (await runtime.snapshot()).tasks[0];
  assert.equal(t.resumeWindow, undefined);
  assert.deepEqual(t.events.at(-1).previous.resumeWindow, { notBefore });
  assert.equal((await runtime.command({ action: 'explain', id })).runnable.runnableNow, true);
  await runtime.dispatcher.tick();
  assert.equal(starts.length, 1);
  await assert.rejects(runtime.command({ action: 'clear-resume', id }), /no queue window/);
});

test('clear-resume keeps an expiry unless asked; expiry: true removes it too', async () => {
  const { runtime } = await fixture();
  const id = await submit(runtime);
  const expiresAt = new Date(Date.now() + 3600e3).toISOString();
  await runtime.dispatcher.update(s => { s.tasks[0].resumeWindow = { notBefore: new Date(Date.now() + 60e3).toISOString(), expiresAt }; });
  await runtime.command({ action: 'clear-resume', id });
  assert.deepEqual((await runtime.snapshot()).tasks[0].resumeWindow, { expiresAt });
  await runtime.command({ action: 'clear-resume', id, expiry: true });
  assert.equal((await runtime.snapshot()).tasks[0].resumeWindow, undefined);
});

test('explain and snapshot show the limits in force now, not the cached task copy (3.4)', async () => {
  const { runtime } = await fixture();
  const id = await submit(runtime);
  await runtime.dispatcher.tick(); await runtime.assess();
  assert.equal((await runtime.store.read()).tasks[0].autoRoundLimit, 200);   // cached at assessment
  const snap = await runtime.snapshot();
  const settings = structuredClone(snap.settings);
  settings.projects[0].followup.maxAutoRounds = 6;
  await runtime.command({ action: 'configure', settings, revision: snap.revision });
  const shown = (await runtime.snapshot()).tasks[0];
  assert.equal(shown.autoRoundLimit, 6);
  assert.equal(shown.autoRoundLimitEvaluated, 200);
  const why = await runtime.command({ action: 'explain', id });
  assert.equal(why.settings.followup.maxAutoRounds, 6);
  assert.equal(why.counters.autoRounds.limit, 6);
  assert.equal(why.lastEvaluated.autoRoundLimit, 200);
  assert.equal(why.statusProperties.terminal, true);
  assert.equal(why.holds.hold, null);
  assert.match(why.runnable.reasons[0], /not queued/);
  // Read-only: explain changes nothing.
  const before = JSON.stringify((await runtime.store.read()).tasks);
  await runtime.command({ action: 'explain', id });
  assert.equal(JSON.stringify((await runtime.store.read()).tasks), before);
  await assert.rejects(runtime.command({ action: 'explain', id: 'missing' }), /not found/);
});

test('explain shows a user hold and why the task is not runnable', async () => {
  const { runtime } = await fixture();
  const id = await submit(runtime);
  await runtime.command({ action: 'stop', id, reason: 'pause this chain' });
  const why = await runtime.command({ action: 'explain', id });
  assert.equal(why.holds.hold.reason, 'pause this chain');
  assert.match(why.runnable.reasons.join(' '), /冻结/);
});

test('drain: running turns finish, nothing new starts (tick, intake, wakes); snapshot reports restart readiness', async () => {
  const issue = { id: 'issue9', identifier: 'EX-9', title: 'T', url: 'https://linear.app/x' };
  const { runtime, starts } = await fixture({ start: () => ({ status: 'running', sessionId: 's' }), issues: () => [issue] });
  await submit(runtime, 1);
  await runtime.dispatcher.tick();
  assert.equal(starts.length, 1);
  await runtime.command({ action: 'drain', reason: 'restart host' });
  let snap = await runtime.snapshot();
  assert.deepEqual([snap.drain.on, snap.drain.reason], [true, 'restart host']);
  assert.equal(snap.restart.idleForRestart, false);
  assert.deepEqual(snap.restart.executing.map(t => t.issue), ['EX-1']);
  await submit(runtime, 2);                          // an explicit owner submit is queued, not started
  await runtime.intake();                            // intake admits nothing while draining
  await runtime.dispatcher.tick();
  snap = await runtime.snapshot();
  assert.equal(starts.length, 1);
  assert.deepEqual(snap.tasks.map(t => t.issue.identifier), ['EX-1', 'EX-2']);
  // The running turn finishes; the host is now idle for a restart.
  runtime.adapters.codex.reconcile = async () => ({ status: 'review', summary: done });
  await runtime.dispatcher.reconcile(); await runtime.assess();
  snap = await runtime.snapshot();
  assert.equal(snap.restart.idleForRestart, true);
  assert.equal(snap.restart.queued, 1);
  // Drain survives a restart (persisted) and undrain resumes starts.
  const again = await new Runtime({ store: runtime.store, directory: os.tmpdir(), env: {} }).init();
  assert.equal((await again.snapshot()).drain.on, true);
  await runtime.command({ action: 'undrain' });
  assert.equal((await runtime.snapshot()).drain.on, false);
  await runtime.dispatcher.tick();
  assert.equal(starts.length, 2);
  assert.deepEqual((await runtime.store.read()).opsLog.map(e => e.action), ['drain', 'undrain']);
});

test('unknown (uncertain) tasks keep idleForRestart false but not idleExceptUncertain', async () => {
  const { runtime } = await fixture({ start: () => ({ status: 'running', sessionId: 's' }) });
  await submit(runtime);
  await runtime.dispatcher.tick();
  await runtime.dispatcher.update(s => { s.tasks[0].status = 'unknown'; });
  const { restart } = await runtime.snapshot();
  assert.deepEqual([restart.idleForRestart, restart.idleExceptUncertain, restart.uncertain.length], [false, true, 1]);
});
