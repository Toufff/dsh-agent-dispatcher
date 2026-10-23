import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rename, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { replaceFile } from '../src/store.js';

test('atomic replacement survives transient Windows sharing conflicts without losing committed evidence', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dispatch-replace-'));
  const source = path.join(directory, 'new'), destination = path.join(directory, 'committed');
  let calls = 0; const delays = [];
  try {
    await writeFile(source, 'new'); await writeFile(destination, 'old');
    await replaceFile(source, destination, async (from, to) => {
      calls++;
      if (calls < 4) {
        assert.equal(await readFile(destination, 'utf8'), 'old');
        assert.equal(await readFile(source, 'utf8'), 'new');
        throw Object.assign(new Error('sharing violation'), { code: ['EPERM', 'EBUSY', 'EACCES'][calls - 1] });
      }
      await rename(from, to);
    }, async delay => delays.push(delay));
    assert.equal(await readFile(destination, 'utf8'), 'new');
    assert.deepEqual(delays, [50, 100, 200]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('atomic replacement has a finite retry budget and immediately propagates unrelated errors', async () => {
  for (const [code, expected] of [['EPERM', 5], ['ENOSPC', 1]]) {
    let calls = 0;
    await assert.rejects(replaceFile('source', 'destination', async () => {
      calls++; throw Object.assign(new Error(code), { code });
    }, async () => {}), { code });
    assert.equal(calls, expected);
  }
});
