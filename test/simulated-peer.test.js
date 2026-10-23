import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runSimulatedPeer } from '../scripts/simulated-peer-acceptance.js';

test('simulated Linear transport exercises trusted reply, durable resume and report readback', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'peer-acceptance-'));
  let starts = 0;
  try {
    const receipt = await runSimulatedPeer({ directory: path.join(root, 'evidence'), pollMs: 1,
      adapter: results => ({ start: async ({ task, attempt }) => {
        starts++;
        if (starts === 2) {
          assert.equal(attempt.resume, true); assert.equal(attempt.sessionId, 'test-original-session');
          assert.match(task.prompt, /External condition changed/); assert.match(task.prompt, /SIMULATED_PEER_ACK/);
        }
        return { status: 'review', sessionId: 'test-original-session', summary: starts === 1 ? results.blocked : results.complete };
      } }) });
    assert.equal(receipt.result, 'passed'); assert.equal(starts, 2);
    assert.equal(receipt.realCrossAccountVerified, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
