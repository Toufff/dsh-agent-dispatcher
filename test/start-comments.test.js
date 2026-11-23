import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { MemoryStore } from '../src/dispatcher.js';
import { initialState } from '../src/config.js';
import { Runtime } from '../src/runtime.js';

const cont = n => `<dispatch-result>${JSON.stringify({ status: 'continue', evidence: ['ok'], remaining: ['a'], next: 'do a', progress: `p${n}`, blockers: [],
  workItems: [{ id: 'a', title: 'a', status: 'ready', dependsOn: [], action: 'do a', evidence: [`e${n}`] }] })}</dispatch-result>`;

test('"started" is commented once per task: automatic rounds, retries and fresh sessions only move the issue state', async () => {
  const store = new MemoryStore(), state = initialState();
  state.paused = false;
  state.settings.projects = [{ id: 'p', label: 'Example', cwd: process.cwd(),
    linear: { enabled: true, tokenEnv: 'TEST_TOKEN', workspaceId: 'w', assigneeId: 'me', round: '1', reviewStateId: 'review', activeStateId: 'active' },
    followup: { enabled: true, commentAuthorIds: [], maxAutoRounds: 50 } }];
  await store.save(state);
  const runtime = await new Runtime({ store, directory: os.tmpdir(), env: { TEST_TOKEN: 'synthetic' }, linearFactory: () => ({
    eligible: async () => ({}), report: async () => {} }) }).init();
  let round = 0;
  runtime.adapters.codex = { start: async () => ({ status: 'running', sessionId: 's' }),
    reconcile: async () => ({ status: 'review', summary: cont(++round) }), stop: async () => ({ status: 'stopped' }) };
  await runtime.submit({ projectId: 'p', prompt: 'Work', issue: { id: 'issue', identifier: 'EX-1' }, source: 'w/issue' });
  const startBodies = async () => (await runtime.store.load()).outbox.filter(i => i.taskStatus === 'running').map(i => i.body);
  await runtime.dispatcher.tick(); await runtime.report();
  assert.equal((await startBodies()).filter(Boolean).length, 1);
  assert.match((await startBodies())[0], /本地 agent 已实际启动/);
  for (let i = 0; i < 3; i++) {                     // three automatic rounds
    await runtime.dispatcher.reconcile(); await runtime.assess(); await runtime.dispatcher.tick(); await runtime.report();
  }
  const id = (await runtime.snapshot()).tasks[0].id;
  await runtime.command({ action: 'stop', id });     // stop + retry
  await runtime.command({ action: 'retry', id });
  await runtime.dispatcher.tick(); await runtime.report();
  const bodies = await startBodies();
  assert.equal(bodies.length, 5, 'every start still moves the issue state');
  assert.equal(bodies.filter(Boolean).length, 1, 'but only the first start comments');
});
