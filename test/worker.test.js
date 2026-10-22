import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CliAdapter } from '../src/adapters/cli.js';

// Includes two OS process launches; keep runtime cleanup assertions independent of host load.
for (const protocol of ['codex', 'codex-linger', 'codex-file-linger', 'claude', 'incomplete']) test(`worker executes and parses ${protocol} protocol`, { timeout: 60000 }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dispatch-worker-'));
  try {
    const worker = fork(new URL('../src/adapters/worker.js', import.meta.url), [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: { ...process.env, CODEX_HOME: directory } });
    const exited = once(worker, 'exit');
    worker.send({ command: process.execPath, args: [path.resolve('scripts/agent-fixture.mjs'), protocol],
      file: path.join(directory, 'attempt.json'), cwd: directory, prompt: 'Synthetic', sessionId: 'initial', completionGraceMs: 200, type: protocol.startsWith('codex') ? 'codex' : protocol });
    await exited;
    const result = JSON.parse(await readFile(path.join(directory, 'attempt.json'), 'utf8'));
    assert.equal(result.status, protocol === 'incomplete' ? 'failed' : 'review');
    if (protocol !== 'incomplete') assert.equal(result.summary, `SYNTHETIC_${protocol.split('-')[0].toUpperCase()}_OK`);
    if (protocol.endsWith('linger')) {
      assert.equal(result.completionSource, protocol === 'codex-file-linger' ? 'session-task-complete' : 'cli-turn-completed');
      assert.match(result.reason, /cleaned up/);
      assert.throws(() => process.kill(result.pid, 0), { code: 'ESRCH' });
    }
  } finally { await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});
test('reloaded adapter stops through the original worker without killing stored PIDs', { timeout: 60000 }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dispatch-worker-'));
  try {
    const worker = fork(new URL('../src/adapters/worker.js', import.meta.url), [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    const acknowledged = once(worker, 'message'), exited = once(worker, 'exit');
    worker.send({ command: process.execPath, args: [path.resolve('scripts/agent-fixture.mjs'), 'hang'],
      file: path.join(directory, 'attempt.json'), cwd: directory, prompt: 'Synthetic', sessionId: 'initial' });
    await acknowledged;
    const restarted = new CliAdapter({ type: 'codex' }, directory);
    // A loaded host can outlast the bounded stop call; only the eventual terminal receipt proves exit.
    const first = await restarted.stop({ attempt: { id: 'attempt' } });
    assert.ok(['stopped', 'unknown'].includes(first.status));
    await exited;
    assert.equal((await restarted.reconcile({ attempt: { id: 'attempt' } })).status, 'stopped');
  } finally { await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});
