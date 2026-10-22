import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOutcome, inspectOutcome } from '../src/outcome.js';
import { captureResultText } from '../src/result-text.js';
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

test('long output preserves the complete trailing contract without hiding ambiguous results', () => {
  const long = 'Narrative '.repeat(40000);
  assert.equal(parseOutcome(captureResultText(long + wrap(valid))).status, 'complete');
  assert.equal(parseOutcome(captureResultText(wrap(valid) + long + wrap(valid))), null);
  assert.equal(parseOutcome(captureResultText(long + wrap(valid) + 'Still unfinished')), null);
  assert.equal(parseOutcome(captureResultText(long)), null);
  assert.equal(parseOutcome(captureResultText('x'.repeat(20000) + wrap(valid))).status, 'complete');
});

test('format repair receives actionable validator locations without echoing private values', () => {
  const bad = { ...valid, evidence: 'private-value', unknown: 'secret-value' };
  const { error, outcome } = inspectOutcome(wrap(bad));
  assert.equal(outcome, null); assert.match(error, /evidence: invalid_type/);
  assert.ok(!error.includes('private-value')); assert.ok(!error.includes('secret-value'));
  assert.match(inspectOutcome(wrap(valid) + 'trailing').error, /last content/);
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
