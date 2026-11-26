// Acceptance (g), opt-in. Needs a directory holding COPIES of the real store (never the original):
//   DSH_ACCEPT_STORE_COPY=<dir with agent_dispatcher_v2/ and archive/>  DSH_ACCEPT_BASE_CODE=<checkout of main>
// Each code tree gets its own fresh copy of that directory; both run the same cycles with the same fakes, and the
// new code must behave exactly like the baseline: same task changes, no starts, no hold migration, no focus.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const source = process.env.DSH_ACCEPT_STORE_COPY, base = process.env.DSH_ACCEPT_BASE_CODE;
const here = path.dirname(fileURLToPath(import.meta.url)), code = path.resolve(here, '..', '..');
const run = async root => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dispatch-copy-'));
  try {
    await cp(source, dir, { recursive: true });
    const { stdout } = await promisify(execFile)(process.execPath, [path.join(here, 'store-copy.mjs'), '--run', '--code', root,
      '--copy', path.join(dir, 'agent_dispatcher_v2'), '--archive', path.join(dir, 'archive'), '--cycles', '6'], { maxBuffer: 64 << 20 });
    return JSON.parse(stdout);
  } finally { await rm(dir, { recursive: true, force: true }); }   // the copy holds real task data: never leave it behind
};

test('(g) a copy of the real store loads with the new code and behaves exactly like main', { skip: !source || !base }, async () => {
  assert.ok(!path.resolve(source).toLowerCase().startsWith(path.resolve(os.homedir(), '.dsh').toLowerCase()), 'use a copy, never ~/.dsh');
  const [now, was] = await Promise.all([run(code), run(path.resolve(base))]);
  assert.deepEqual(now.starts, [], 'no task starts');
  assert.equal(now.heldAfterInit, now.heldBefore, 'no hold migration at load');
  assert.equal(now.heldAfter, now.heldBefore, 'no hold migration while cycling');
  assert.equal(now.focus, false); assert.equal(now.settingsLinear, false); assert.deepEqual(now.unknown, []); assert.deepEqual(now.errors, []);
  for (const key of ['tasks', 'statusBefore', 'statusAfter', 'starts', 'writes', 'outbox', 'changed']) assert.deepEqual(now[key], was[key], key);
  // Merged exit (intended difference): queued tasks' admission and pending state moves ride on the sync's single
  // watched read instead of one read per start, so the new code may add at most one watched read per cycle and only
  // when the copy has queued tasks / pending state moves. Every other read kind must match the baseline exactly.
  const { watched: nowWatched = 0, ...nowOps } = now.ops, { watched: wasWatched = 0, ...wasOps } = was.ops;
  assert.deepEqual(nowOps, wasOps, 'ops');
  assert.ok(nowWatched <= wasWatched + (now.queued.length ? now.cycles : 0), `watched reads: ${nowWatched} vs ${wasWatched}`);
});
