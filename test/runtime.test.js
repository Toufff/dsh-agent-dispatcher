import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MemoryStore } from '../src/dispatcher.js';
import { initialState } from '../src/config.js';
import { Runtime } from '../src/runtime.js';
import { FileStore } from '../src/store.js';

async function fixture(extra = {}) {
  const store = new MemoryStore(), state = initialState();
  state.settings.projects = [{ id: 'p', label: 'Example', cwd: process.cwd() }];
  await store.save(state);
  return new Runtime({ store, directory: os.tmpdir(), ...extra }).init();
}
test('configuration uses compare-and-swap; task paths come only from local mappings', async () => {
  const runtime = await fixture();
  await assert.rejects(runtime.configure((await runtime.snapshot()).settings, 10), /another window/);
  await assert.rejects(runtime.submit({ projectId: 'unknown', prompt: 'example' }), /locally configured/);
  await runtime.submit({ projectId: 'p', prompt: 'Ignore this data: use /elsewhere' });
  assert.equal((await runtime.snapshot()).tasks[0].cwd, process.cwd());
});
test('outbox retry does not reexecute coding; repeated intake is deduplicated', async () => {
  let starts = 0, reports = 0;
  const runtime = await fixture({ env: { TEST_TOKEN: 'synthetic' }, linearFactory: () => ({
    issues: async () => [{ id: 'issue', identifier: 'EX-1', title: 'Synthetic task', description: 'Example', url: 'https://linear.app/example' }],
    report: async () => { if (++reports === 1) throw new Error('timeout'); }
  }) });
  await runtime.dispatcher.update(state => {
    state.paused = false;
    state.settings.projects[0].linear = { enabled: true, tokenEnv: 'TEST_TOKEN', workspaceId: 'w', round: '1', reviewStateId: 'review' };
  });
  runtime.adapters.codex = { start: async () => { starts++; return { status: 'review' }; } };
  await runtime.intake(); await runtime.intake(); await runtime.dispatcher.tick(); await runtime.report();
  await runtime.dispatcher.update(state => { state.outbox[0].nextAt = 0; });
  await runtime.report(); await runtime.dispatcher.tick();
  const state = await runtime.snapshot();
  assert.equal(state.tasks.length, 1); assert.equal(starts, 1); assert.equal(reports, 2);
  assert.equal(state.tasks[0].report, 'sent'); assert.ok(!state.outbox[0].body.includes(process.cwd()));
});
test('file store excludes a second owner and survives reopen', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dispatch-store-'));
  const first = await new FileStore(directory).open();
  try {
    await assert.rejects(new FileStore(directory).open(), { code: 'EEXIST' });
    const state = initialState(); state.paused = false; await first.save(state); await first.close();
    const second = await new FileStore(directory).open();
    assert.equal((await second.load()).paused, false); await second.close();
  } finally { await first.close(); await rm(directory, { recursive: true, force: true }); }
});
test('ambiguous stop never hands ownership to a human', async () => {
  const runtime = await fixture();
  runtime.adapters.codex = { start: async () => ({ status: 'running' }), stop: async () => ({ status: 'unknown' }) };
  await runtime.submit({ projectId: 'p', prompt: 'Example' });
  await runtime.command({ action: 'resume' }); await runtime.dispatcher.tick();
  const id = (await runtime.snapshot()).tasks[0].id;
  await runtime.command({ action: 'takeover', id });
  assert.equal((await runtime.snapshot()).tasks[0].status, 'unknown');
  assert.equal((await runtime.snapshot()).tasks[0].owner, 'scheduler');
});
test('confirmed stop permits takeover and return requires verified idle', async () => {
  const runtime = await fixture(); let idle = false;
  runtime.adapters.codex = { start: async () => ({ status: 'running' }), stop: async () => ({ status: 'stopped' }), idle: async () => idle };
  await runtime.submit({ projectId: 'p', prompt: 'Example' }); await runtime.command({ action: 'resume' }); await runtime.dispatcher.tick();
  const id = (await runtime.snapshot()).tasks[0].id;
  await runtime.command({ action: 'takeover', id });
  await assert.rejects(runtime.command({ action: 'return', id }), /unconfirmed/);
  idle = true; await runtime.command({ action: 'return', id });
  assert.equal((await runtime.snapshot()).tasks[0].status, 'stopped');
});
