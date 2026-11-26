import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { initialState } from './config.js';

// Windows readers/antivirus may briefly hold the destination open. Retry the
// same atomic replacement, never unlink the committed file or rerun the writer.
export async function replaceFile(source, destination, renameFile = rename, delay = ms => new Promise(resolve => setTimeout(resolve, ms))) {
  for (let tries = 0; ; tries++) {
    try { await renameFile(source, destination); return; }
    catch (error) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(error.code) || tries >= 4) throw error;
      await delay(50 * 2 ** tries);
    }
  }
}

export async function writeJson(file, data) {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  const handle = await open(temp, 'w', 0o600);
  try { await handle.writeFile(JSON.stringify(data)); await handle.sync(); }
  finally { await handle.close(); }
  await replaceFile(temp, file);
}

/** Standalone test/diagnostic store; production plugin uses DSH domain storage. */
export class FileStore {
  constructor(directory) { this.file = path.join(directory, 'dispatcher.json'); this.lockFile = `${this.file}.lock`; }
  async open() {
    await mkdir(path.dirname(this.file), { recursive: true });
    this.lock = await open(this.lockFile, 'wx', 0o600);
    await this.lock.writeFile(String(process.pid));
    return this;
  }
  async load() {
    try { return JSON.parse(await readFile(this.file, 'utf8')); }
    catch (e) { if (e.code === 'ENOENT') return initialState(); throw e; }
  }
  async save(state) { await writeJson(this.file, state); }
  async close() { if (this.lock) { await this.lock.close(); await unlink(this.lockFile); this.lock = null; } }
}

// Windows readers/antivirus may briefly hold a storage file open; retry the same durable write.
export async function retrying(write, delay = ms => new Promise(resolve => setTimeout(resolve, ms))) {
  for (let tries = 0; ; tries++) {
    try { return await write(); }
    catch (error) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(error.code) || tries >= 4) throw error;
      await delay(50 * 2 ** tries);
    }
  }
}

// Cross-process exclusion (host.lock, with stale-owner takeover and PID-reuse detection) lives in host-lease.js.
export { acquireLease } from './host-lease.js';
