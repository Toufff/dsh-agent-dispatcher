import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LinearClient } from '../src/linear.js';

test('intake validates workspace before reading issues', async () => {
  let calls = 0;
  const client = new LinearClient('synthetic', async () => { calls++; return { ok: true, json: async () => ({ data: { organization: { id: 'different' } } }) }; });
  await assert.rejects(client.issues({ workspaceId: 'expected' }), /another workspace/); assert.equal(calls, 1);
});
test('report retries find the exact comment and never regress a completed issue', async () => {
  const queries = [];
  const client = new LinearClient('synthetic', async (url, request) => {
    const data = JSON.parse(request.body); queries.push(data.query);
    assert.equal(url, 'https://api.linear.app/graphql');
    return { ok: true, json: async () => ({ data: { issue: { state: { type: 'completed' }, comments: {
      nodes: [{ id: 'comment' }], pageInfo: { hasNextPage: false, endCursor: null }
    } } } }) };
  });
  await client.report({ id: 'comment', issueId: 'issue', stateId: 'review', body: 'Synthetic' });
  assert.equal(queries.length, 1); assert.ok(!queries[0].includes('mutation'));
});
