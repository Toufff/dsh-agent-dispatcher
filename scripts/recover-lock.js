import { readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
const directory = process.argv[2];
if (!directory || !path.isAbsolute(directory)) throw new Error('Pass the absolute private runtime directory');
const file = path.join(directory, 'host.lock');
const lock = JSON.parse(await readFile(file, 'utf8'));
if (!Number.isSafeInteger(lock.pid) || lock.pid <= 0) throw new Error('Invalid lock; inspect manually');
let dead = false;
try { process.kill(lock.pid, 0); } catch (e) { if (e.code === 'ESRCH') dead = true; else throw e; }
if (!dead) throw new Error('Owner PID is alive; refusing to remove its lock');
await unlink(file);
console.log('Removed stale host lock. Existing tasks will be reconciled, not restarted.');
