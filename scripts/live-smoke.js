import { CliAdapter } from '../src/adapters/cli.js';
import { mkdtemp } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
const type = process.argv[2] || 'codex';
if (!['codex', 'claude'].includes(type)) throw new Error('Expected codex or claude');
const directory = await mkdtemp(path.join(os.tmpdir(), 'dispatch-live-'));
const adapter = new CliAdapter({ type, command: process.env.DISPATCH_SMOKE_COMMAND || type,
  sandbox: 'read-only' }, directory);
const context = { task: { cwd: process.cwd(), prompt: 'Do not use tools or change files. Reply exactly: DISPATCH_SMOKE_OK' },
  attempt: { id: randomUUID(), sessionId: randomUUID() } };
let result = await adapter.start(context);
const until = Date.now() + 180000;
while (Date.now() < until && ['running', 'starting', 'finishing', 'unknown'].includes(result.status)) {
  await new Promise(resolve => setTimeout(resolve, 1000)); result = await adapter.reconcile(context);
}
if (result.status !== 'review' || !result.summary.includes('DISPATCH_SMOKE_OK')) {
  await adapter.stop(context);
  console.error(JSON.stringify({ type, status: result.status, reason: result.reason })); process.exitCode = 1;
} else console.log(JSON.stringify({ type, status: result.status, markerVerified: true, sessionPersisted: Boolean(result.sessionId) }));
