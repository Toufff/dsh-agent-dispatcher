import { execFile } from 'node:child_process';
import { appendFile, mkdir, open, readFile, stat, unlink } from 'node:fs/promises';
import path from 'node:path';

// Two process start times closer than this are the same process (clock rounding, reporting jitter). Both sides
// now come from the OS (see ownProcess), so this only absorbs rounding; it is wide enough for a small clock step.
const SAME_PROCESS_MS = 5000;
// A takeover mutex older than this belongs to a host that died mid-takeover.
const TAKEOVER_STALE_MS = 60_000;

const execText = (file, args) => new Promise(resolve =>
  execFile(file, args, { timeout: 10_000, windowsHide: true }, (error, stdout) => resolve(error ? '' : String(stdout).trim())));

/** This process: pid and process start time (not the lock time), so a later host can detect PID reuse. */
export function selfProcess() {
  return { pid: process.pid, processStartedAt: new Date(Date.now() - process.uptime() * 1000).toISOString() };
}
/**
 * This process with its start time read from the SAME source a later host's probe uses (the OS process table), so a
 * wall-clock step or sleep between start and lease time cannot make a live host look like a reused pid. Falls back
 * to the uptime estimate when the OS start time cannot be read.
 */
export async function ownProcess(probe = probeProcess) {
  const fallback = selfProcess();
  try {
    const info = await probe(process.pid);
    if (Number.isFinite(info?.startedAt)) return { pid: process.pid, processStartedAt: new Date(info.startedAt).toISOString() };
  } catch { /* fall back */ }
  return fallback;
}

/**
 * Default probe: { alive, startedAt? (ms) }. Liveness from signal 0 (EPERM = alive, owned by someone else); the
 * start time is best-effort (Get-Process on Windows, ps elsewhere). Unknown start time means "cannot tell".
 */
export async function probeProcess(pid) {
  try { process.kill(pid, 0); }
  catch (error) { if (error.code === 'ESRCH') return { alive: false }; if (error.code !== 'EPERM') return { alive: true }; }
  const text = process.platform === 'win32'
    ? await execText('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `(Get-Process -Id ${Number(pid)} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`])
    : await execText('ps', ['-o', 'lstart=', '-p', String(pid)]);
  const startedAt = Date.parse(text);
  return { alive: true, ...(Number.isFinite(startedAt) ? { startedAt } : {}) };
}

/**
 * Whether a recorded lock still has a live owner. Stale when the pid is gone, or alive but a different process:
 * its start time differs from the recorded processStartedAt, or (locks written before start times were recorded)
 * it started after the lock itself was written — a process cannot write a lock before it exists (Windows PID reuse).
 * Anything that cannot be decided (invalid record, alive with unknown start time) is not stale.
 */
export async function lockStaleness(lock, probe = probeProcess) {
  if (!Number.isSafeInteger(lock?.pid) || lock.pid <= 0) return { stale: false, reason: 'invalid lock record' };
  const info = await probe(lock.pid);
  if (!info?.alive) return { stale: true, reason: 'owner-dead' };
  if (!Number.isFinite(info.startedAt)) return { stale: false, reason: 'owner alive (start time unknown)' };
  const recorded = Date.parse(lock.processStartedAt);
  if (Number.isFinite(recorded))
    return Math.abs(info.startedAt - recorded) > SAME_PROCESS_MS ? { stale: true, reason: 'pid-reused' } : { stale: false, reason: 'owner alive' };
  const written = Date.parse(lock.startedAt);
  if (Number.isFinite(written) && info.startedAt > written + SAME_PROCESS_MS) return { stale: true, reason: 'pid-reused' };
  return { stale: false, reason: 'owner alive' };
}

async function readLock(file) {
  const text = await readFile(file, 'utf8');
  try { return { text, lock: JSON.parse(text) }; } catch { return { text, lock: null }; }
}

async function create(file, self, now) {
  const handle = await open(file, 'wx', 0o600);
  const text = JSON.stringify({ ...self, startedAt: new Date(now()).toISOString() });
  await handle.writeFile(text);
  return { handle, text };
}

/**
 * Cross-process exclusion of the runtime directory through host.lock. A lock whose owner is provably gone (dead
 * pid, or a reused pid) is taken over under a takeover mutex (host.lock.takeover, exclusive create): the lock is
 * re-read under the mutex and replaced only if it is still the record judged stale, so two starting hosts never
 * both win. Each takeover appends one JSON line to host-lock-audit.log. A live owner is refused as before.
 */
export async function acquireLease(directory, { probe = probeProcess, self, now = Date.now, log = () => {} } = {}) {
  self ??= await ownProcess(probe);
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, 'host.lock');
  const mutexFile = `${file}.takeover`;
  const audit = path.join(directory, 'host-lock-audit.log');
  let handle, written;
  for (let tries = 0; !handle; tries++) {
    try { ({ handle, text: written } = await create(file, self, now)); break; }
    catch (e) { if (e.code !== 'EEXIST') throw e; }
    if (tries >= 3) throw new Error('Dispatcher host lock is contended; retry the start.');
    let seen;
    try { seen = await readLock(file); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
    const verdict = seen.lock ? await lockStaleness(seen.lock, probe) : { stale: false, reason: 'unreadable lock record' };
    if (!verdict.stale)
      throw new Error(`Dispatcher host lock exists (${verdict.reason}). Stop the other host or recover its stale lock before restarting.`);
    let mutex;
    try { mutex = await open(mutexFile, 'wx', 0o600); }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const age = await stat(mutexFile).then(s => now() - s.mtimeMs, () => 0);
      if (age > TAKEOVER_STALE_MS) { await unlink(mutexFile).catch(() => {}); continue; }
      throw new Error('Another host is taking over the stale dispatcher lock; retry the start.');
    }
    try {
      const current = await readLock(file).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
      if (current && current.text !== seen.text) continue;   // the lock changed since it was judged: judge again
      if (current) await unlink(file);
      ({ handle, text: written } = await create(file, self, now));
      const line = { at: new Date(now()).toISOString(), action: 'host-lock-takeover', reason: verdict.reason,
        previous: seen.lock, pid: self.pid, processStartedAt: self.processStartedAt };
      await appendFile(audit, `${JSON.stringify(line)}\n`, { mode: 0o600 });
      try { log(`agent-dispatcher: took over stale host.lock (${verdict.reason}, previous pid ${seen.lock.pid})`); } catch { /* optional */ }
    } finally { await mutex.close(); await unlink(mutexFile).catch(() => {}); }
  }
  // Release removes host.lock only while it is still the record this host wrote (another host may have taken over).
  return async () => {
    await handle.close();
    const current = await readFile(file, 'utf8').catch(() => null);
    if (current === written) await unlink(file).catch(e => { if (e.code !== 'ENOENT') throw e; });
  };
}
