import { fork } from 'node:child_process';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function cliArgs(config, task, attempt) {
  if (config.type === 'codex') {
    const common = ['--json', '--color', 'never'];
    return ['exec', ...(config.args ?? []), ...(attempt.resume
      ? ['resume', ...common.filter(v => !['--color', 'never'].includes(v)), attempt.sessionId, '-']
      : [...common, '--sandbox', config.sandbox ?? 'workspace-write', '-'])];
  }
  return ['--print', '--verbose', '--output-format', 'stream-json',
    ...(config.args ?? []), ...(attempt.resume ? ['--resume', attempt.sessionId] : ['--session-id', attempt.sessionId])];
}

/** The worker owns durable execution receipts; it may outlive a plugin reload. */
export class CliAdapter {
  constructor(config, directory) { this.config = config; this.directory = directory; this.workers = new Map(); }
  file(attempt) { return path.join(this.directory, `${attempt.id}.json`); }
  async start({ task, attempt }) {
    await mkdir(this.directory, { recursive: true });
    const child = fork(fileURLToPath(new URL('./worker.js', import.meta.url)), [], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true, detached: false
    });
    this.workers.set(attempt.id, child);
    child.once('exit', () => this.workers.delete(attempt.id));
    const result = new Promise(resolve => {
      const timer = setTimeout(() => resolve({ status: 'unknown', reason: 'Start acknowledgement timed out' }), 15000);
      child.once('error', () => { clearTimeout(timer); resolve({ status: 'rejected', reason: 'Worker could not start' }); });
      child.once('message', result => { clearTimeout(timer); resolve(result); });
    });
    child.send({ command: this.config.command || this.config.type, args: cliArgs(this.config, task, attempt),
      type: this.config.type, cwd: task.cwd, prompt: task.prompt, file: this.file(attempt), sessionId: attempt.sessionId });
    return result;
  }
  async reconcile({ attempt }) {
    try {
      const receipt = JSON.parse(await readFile(this.file(attempt), 'utf8'));
      if (['running', 'waiting'].includes(receipt.status) && !this.workers.has(attempt.id)) {
        try { process.kill(receipt.workerPid, 0); }
        catch { return { ...receipt, status: 'unknown', reason: 'Worker disappeared without terminal receipt' }; }
      }
      return receipt;
    } catch { return { status: 'unknown', reason: 'No durable execution receipt' }; }
  }
  async idle(context) {
    const result = await this.reconcile(context);
    return ['review', 'failed', 'stopped', 'rejected'].includes(result.status);
  }
  async stop(context) {
    const current = await this.reconcile(context);
    if (['review', 'failed', 'stopped', 'rejected'].includes(current.status)) return { status: 'stopped' };
    const worker = this.workers.get(context.attempt.id);
    // Never kill a PID from an old receipt: PIDs can be reused by unrelated processes.
    if (!worker?.connected) return { status: 'unknown', reason: 'Reconnect manually before stopping an orphaned worker' };
    worker.send({ stop: true });
    for (let n = 0; n < 50; n++) {
      await new Promise(resolve => setTimeout(resolve, 100));
      if (await this.idle(context)) return { status: 'stopped' };
    }
    return { status: 'unknown', reason: 'Termination not confirmed' };
  }
  async health() { return { available: Boolean(this.config.command), verification: this.config.verified ? 'verified' : 'unverified' }; }
}
