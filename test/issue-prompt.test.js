import { test } from 'node:test';
import assert from 'node:assert/strict';
import { issuePrompt } from '../src/runtime.js';

test('issue prompt leads with the Linear identifier and links the issue', () => {
  const prompt = issuePrompt({ id: 'uuid', identifier: 'LON-28', title: '短线情绪龙头因子挖掘',
    url: 'https://linear.app/x/issue/LON-28', description: 'Find leaders.' });
  assert.ok(prompt.startsWith('LON-28 短线情绪龙头因子挖掘\n'));
  assert.match(prompt, /Linear issue: LON-28 https:\/\/linear\.app\/x\/issue\/LON-28/);
  assert.match(prompt, /Find leaders\./);
  assert.match(prompt, /Return a concise implementation and verification summary\.$/);
});

test('issue prompt still works without identifier, url or description', () => {
  assert.equal(issuePrompt({ id: 'uuid', title: 'Plain' }), 'Plain\n\n\n\nReturn a concise implementation and verification summary.');
});
