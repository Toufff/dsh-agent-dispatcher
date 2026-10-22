import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOutcome } from '../src/outcome.js';
const valid = { status: 'complete', evidence: ['tests passed'], remaining: [], next: '', progress: 'verified', blockers: [] };
const wrap = value => `<dispatch-result>${JSON.stringify(value)}</dispatch-result>`;
test('completion requires evidence and no unfinished work, malformed or ambiguous results fail closed', () => {
  assert.equal(parseOutcome(wrap(valid)).status, 'complete');
  for (const change of [{ evidence: [] }, { remaining: ['not done'] }, { next: 'do more' }, { unknown: true }])
    assert.equal(parseOutcome(wrap({ ...valid, ...change })), null);
  assert.equal(parseOutcome(wrap(valid) + wrap(valid)), null);
  assert.equal(parseOutcome(wrap(valid) + ' actually incomplete'), null);
  assert.equal(parseOutcome('finished'), null);
});

test('conditional next steps and expiry-only Linear waits classify as blocked, never complete', () => {
  const blocked = { ...valid, status: 'blocked', remaining: ['receipt'], next: 'After verification, release',
    blockers: [{ owner: 'peer', reason: 'missing receipt', resumeWhen: 'verified receipt' }],
    wait: { kind: 'linear', condition: 'verify receipt', expiresAt: '2030-01-01T21:30:00+08:00' } };
  assert.equal(parseOutcome(wrap(blocked)).status, 'blocked');
  assert.equal(parseOutcome(wrap({ ...blocked, status: 'complete' })), null);
  assert.equal(parseOutcome(wrap({ ...blocked, wait: { ...blocked.wait, kind: 'time' } })), null);
  assert.equal(parseOutcome(wrap({ ...blocked, wait: { ...blocked.wait, notBefore: '2030-01-01T22:00:00+08:00' } })), null);
  assert.equal(parseOutcome(wrap({ ...blocked, wait: { ...blocked.wait, expiresAt: 'tomorrow' } })), null);
});
