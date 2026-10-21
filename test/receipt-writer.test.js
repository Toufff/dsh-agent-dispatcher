import { test } from 'node:test';
import assert from 'node:assert/strict';
import { receiptWriter } from '../src/adapters/receipt-writer.js';

test('transient write failure retries the same snapshot before later snapshots', async () => {
  let count = 0; const saved = [], errors = [];
  const save = receiptWriter('unused', { write: async (_, value) => {
    if (++count === 1) throw Object.assign(new Error('private path and secret'), { code: 'EPERM' });
    saved.push(value.status);
  }, delay: async () => {}, diagnostic: async entry => errors.push(entry) });
  await Promise.all([save({ status: 'running' }), save({ status: 'review' })]);
  assert.deepEqual(saved, ['running', 'review']);
  assert.equal(errors[0].code, 'EPERM');
  assert.ok(!JSON.stringify(errors).includes('private'));
});

test('exhausted retries do not poison subsequent completion writes', async () => {
  let unavailable = true; const saved = [];
  const save = receiptWriter('unused', { write: async (_, value) => {
    if (unavailable) throw Object.assign(new Error('unavailable'), { code: 'EIO' });
    saved.push(value);
  }, delay: async () => {}, diagnostic: async () => {} });
  await assert.rejects(save({ status: 'running' }), { code: 'EIO' });
  unavailable = false;
  await save({ status: 'review', summary: 'completed' });
  assert.equal(saved[0].status, 'review');
});
