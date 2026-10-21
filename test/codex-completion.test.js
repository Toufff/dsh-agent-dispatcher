import { test } from 'node:test';
import assert from 'node:assert/strict';
import { completedTurn } from '../src/adapters/codex-completion.js';
const line = (type, timestamp) => JSON.stringify({ type: 'event_msg', timestamp, payload: { type, last_agent_message: 'Result' } });
test('resume cannot mistake an old completed turn for the current task', () => {
  const now = Date.now();
  assert.equal(completedTurn(line('task_complete', new Date(now - 1000)), now), null);
  assert.equal(completedTurn(line('task_complete', new Date(now + 1000)), now).summary, 'Result');
  assert.equal(completedTurn([line('task_complete', new Date(now + 1000)), line('task_started', new Date(now + 2000))].join('\n'), now), null);
  assert.equal(completedTurn(line('turn_aborted', new Date(now + 1000)), now), null);
});
