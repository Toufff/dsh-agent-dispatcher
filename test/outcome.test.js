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
