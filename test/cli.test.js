import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { CliAdapter, cliArgs } from '../src/adapters/cli.js';

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
