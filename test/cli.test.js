import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { CliAdapter, cliArgs } from '../src/adapters/cli.js';
import { writeJson } from '../src/store.js';

test('Codex automatic approval mode avoids the mutually exclusive sandbox option', () => {
  const args = cliArgs({ type: 'codex', args: ['--approve-for-me'] }, {}, { resume: true, sessionId: 'session' });
  assert.ok(args.includes('--approve-for-me'));
  assert.ok(!args.includes('--sandbox'));
  assert.ok(args.includes('resume'));
});

test('stale heartbeat is unknown even while the worker remains in memory', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dispatch-stale-'));
  try {
    const adapter = new CliAdapter({ type: 'codex' }, directory);
    adapter.workers.set('attempt', {});
    await writeJson(path.join(directory, 'attempt.json'), { status: 'running', heartbeat: Date.now() - 60000, workerPid: process.pid });
    assert.equal((await adapter.reconcile({ attempt: { id: 'attempt' } })).status, 'unknown');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('worker environment excludes Linear credentials but preserves normal runtime environment', () => {
  const keys = ['DISPATCH_LINEAR_TEST_SECRET', 'CUSTOM_DISPATCH_TEST_SECRET'];
  const previous = keys.map(key => process.env[key]);
  try {
    for (const key of keys) process.env[key] = 'synthetic-secret';
    const adapter = new CliAdapter({ type: 'codex' }, '.', [keys[1]]);
    for (const key of keys) assert.equal(adapter.workerEnv[key], undefined);
    const pathKey = Object.keys(process.env).find(key => key.toLowerCase() === 'path');
    assert.equal(adapter.workerEnv[pathKey], process.env[pathKey]);
  } finally {
    keys.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; });
  }
});

test('Claude adapter uses official streaming and explicit session resume', () => {
  const args = cliArgs({ type: 'claude' }, {}, { resume: true, sessionId: 'example-session' });
  assert.deepEqual(args, ['--print', '--verbose', '--output-format', 'stream-json', '--resume', 'example-session']);
  assert.ok(!args.some(arg => arg.includes('dangerously')));
});
test('missing executable is a confirmed rejection with durable receipt', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dispatch-cli-'));
  try {
    const adapter = new CliAdapter({ type: 'codex', command: path.join(directory, 'missing-executable') }, directory);
    const context = { task: { cwd: directory, prompt: 'Synthetic' }, attempt: { id: 'attempt', sessionId: 'session' } };
    await adapter.start(context);
    for (let i = 0; i < 30 && adapter.workers.size; i++) await new Promise(r => setTimeout(r, 50));
    assert.equal((await adapter.reconcile(context)).status, 'rejected');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
