import { fork } from 'node:child_process';
import { readFile, mkdir, access } from 'node:fs/promises';
import { writeJson } from '../store.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function cliArgs(config, task, attempt) {
  if (config.type === 'codex') {
    const common = ['--json', '--color', 'never'];
    const sandbox = config.args?.includes('--approve-for-me') ? [] : ['--sandbox', config.sandbox ?? 'workspace-write'];
    return ['exec', ...sandbox, ...(config.args ?? []), ...(attempt.resume
      ? ['resume', ...common.filter(v => !['--color', 'never'].includes(v)), attempt.sessionId, '-']
      : [...common, '-'])];
  }
  return ['--print', '--verbose', '--output-format', 'stream-json',
    ...(config.args ?? []), ...(attempt.resume ? ['--resume', attempt.sessionId] : ['--session-id', attempt.sessionId])];
}

/** The worker owns durable execution receipts; it may outlive a plugin reload. */
export class CliAdapter {
  constructor(config, directory, secretKeys = []) {
    this.config = config; this.directory = directory; this.workers = new Map();
    this.workerEnv = Object.fromEntries(Object.entries(process.env)
      .filter(([key]) => !secretKeys.some(secret => secret.toLowerCase() === key.toLowerCase()) && !/^(LINEAR_|DISPATCH_LINEAR_)/i.test(key)));
  }
  file(attempt) { return path.join(this.directory, `${attempt.id}.json`); }
  async start({ task, attempt }) {
    await mkdir(this.directory, { recursive: true });
    const child = fork(fileURLToPath(new URL('./worker.js', import.meta.url)), [], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true, detached: false, env: this.workerEnv
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
      if (['running', 'waiting'].includes(receipt.status)) {
        if (!receipt.heartbeat || Date.now() - receipt.heartbeat > 15000)
          return { ...receipt, status: 'unknown', reason: 'Execution heartbeat is stale' };
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
    // The original worker owns termination. A reloaded plugin never kills a stored PID.
    await writeJson(`${this.file(context.attempt)}.stop`, { stop: true });
    const worker = this.workers.get(context.attempt.id);
    if (worker?.connected) worker.send({ stop: true });
    for (let n = 0; n < 50; n++) {
      await new Promise(resolve => setTimeout(resolve, 100));
      if (await this.idle(context)) return { status: 'stopped' };
    }
    return { status: 'unknown', reason: 'Termination not confirmed' };
  }
  async health() {
    const command = this.config.command || this.config.type;
    const candidates = path.isAbsolute(command) ? [command] : (process.env.PATH || '').split(path.delimiter)
      .flatMap(directory => [path.join(directory, command), ...(process.platform === 'win32' ? [path.join(directory, `${command}.exe`)] : [])]);
    let available = false;
    for (const candidate of candidates) { try { await access(candidate); available = true; break; } catch {} }
    return { available, verification: this.config.verified ? 'verified' : 'unverified' };
  }
  async verifyReturn() { return null; } // Official CLIs expose no cross-process manual-session lease.
}
