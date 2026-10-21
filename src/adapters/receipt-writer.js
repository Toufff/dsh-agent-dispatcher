import { appendFile } from 'node:fs/promises';
import { writeJson } from '../store.js';

/** Serialize snapshots without letting one failed write poison later writes. */
export function receiptWriter(file, { write = writeJson, delay = ms => new Promise(r => setTimeout(r, ms)),
  diagnostic = entry => appendFile(`${file}.errors.jsonl`, `${JSON.stringify(entry)}\n`, { mode: 0o600 }) } = {}) {
  let tail = Promise.resolve();
  return value => {
    const snapshot = structuredClone(value);
    const operation = tail.then(async () => {
      for (let attempt = 1; ; attempt++) {
        try { await write(file, snapshot); return; }
        catch (error) {
          const code = /^[A-Z0-9_]{1,32}$/.test(error.code || '') ? error.code : 'WRITE_FAILED';
          await diagnostic({ at: new Date().toISOString(), code, attempt, status: snapshot.status }).catch(() => {});
          if (attempt >= 5) throw error;
          await delay(50 * 2 ** (attempt - 1));
        }
      }
    });
    tail = operation.catch(() => {});
    return operation;
  };
}
