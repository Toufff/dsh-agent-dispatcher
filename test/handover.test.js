import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { MemoryStore } from '../src/dispatcher.js';
import { initialState } from '../src/config.js';
import { Runtime } from '../src/runtime.js';
import { freshHandover, latestHandoverOnly, stripHandovers } from '../src/workflow.js';
import { workItems } from './workflow-fixtures.js';

const done = `<dispatch-result>${JSON.stringify({ status: 'complete', workItems: workItems('complete'), evidence: ['ok'], remaining: [], next: '', progress: 'done', blockers: [] })}</dispatch-result>`;
const count = text => (text.match(/FRESH SESSION: /g) || []).length;
const tokens = n => freshHandover(`the session context reached ${n} tokens`);

async function fixture({ comments = () => [], state: seed } = {}) {
  const store = new MemoryStore(), state = seed || initialState();
  state.paused = false;
  state.settings.projects = [{ id: 'p', label: 'Example', cwd: process.cwd(),
    linear: { enabled: true, tokenEnv: 'TEST_TOKEN', workspaceId: 'w', assigneeId: 'me', round: '1', reviewStateId: 'review' },
    followup: { enabled: true, commentAuthorIds: ['peer', 'me'], maxWakeups: 8, reviewComments: true } }];
  await store.save(state);
  const runtime = await new Runtime({ store, directory: os.tmpdir(), env: { TEST_TOKEN: 'synthetic' }, linearFactory: () => ({
    eligible: async () => ({}), activity: async () => ({ comments: comments() }) }) }).init();
  runtime.adapters.codex = { start: async () => ({ status: 'review', summary: done, sessionId: 'original-session' }) };
  return { runtime, store };
}

test('repeated retries in a fresh session keep exactly one, current handover', async () => {
  const { runtime } = await fixture();
  await runtime.submit({ projectId: 'p', prompt: 'Work', issue: { id: 'issue', identifier: 'EX-1' }, source: 'w/issue' });
  await runtime.dispatcher.tick(); await runtime.assess();
  const id = (await runtime.snapshot()).tasks[0].id;
  let n = 250000;
  runtime.adapters.codex.contextTokens = async () => n;
  for (const next of [300000, 410000, 520000]) {
    await runtime.dispatcher.update(s => { const t = s.tasks[0]; t.status = 'stopped';
      t.attempts = [{ id: `a${next}`, executor: 'codex', status: 'stopped', accepted: true, sessionId: `s${next}` }]; });
    n = next;
    await runtime.command({ action: 'retry', id });
    const t = (await runtime.snapshot()).tasks[0];
    assert.equal(count(t.prompt), 1, 'one handover');
    assert.match(t.prompt, new RegExp(`^FRESH SESSION: .*reached ${next} tokens`));
  }
});

test('a comment round in a fresh session keeps the handover out of the instruction history and base prompt', async () => {
  const at = new Date(Date.now() + 1000).toISOString();
  let k = 0;
  const { runtime } = await fixture({ comments: () => [{ id: `c${k}`, body: `request ${k}`, createdAt: at, updatedAt: at, user: { id: 'peer' } }] });
  runtime.adapters.codex.contextTokens = async () => 250000;
  await runtime.submit({ projectId: 'p', prompt: 'Work', issue: { id: 'issue', identifier: 'EX-1' }, source: 'w/issue' });
  await runtime.dispatcher.tick(); await runtime.assess();
  for (let round = 1; round <= 3; round++) {
    await runtime.reviewComments();
    const s = await runtime.snapshot(), next = s.tasks.at(-1);
    assert.equal(s.tasks.length, round + 1);
    assert.equal(count(next.prompt), 1);
    assert.match(next.prompt, /^FRESH SESSION: /);
    assert.equal(count(next.basePrompt), 0);
    assert.ok(next.ownerInstructions.every(text => !count(text)));
    await runtime.dispatcher.tick(); await runtime.assess();
    runtime.reviewCheckedAt.clear(); k++;
  }
});

test('stacked handovers in stored tasks are cut back to the newest one on load', async () => {
  const state = initialState();
  const base = 'Goal\n\nLocal project restrictions: x';
  state.tasks = [{ id: 't1', key: '["s","1"]', cwd: process.cwd(), title: 't', executors: ['codex'], status: 'queued', attempts: [], events: [],
      owner: 'scheduler', report: 'pending', projectId: 'p', createdAt: new Date().toISOString(),
      prompt: `${tokens(520000)}\n\n${tokens(410000)}\n\n${tokens(300000)}\n\n${base}`,
      basePrompt: `${tokens(100000)}\n\nGoal`, ownerInstructions: [`${tokens(90000)}\n\nplease do X`, 'then Y'] },
    { id: 't2', key: '["s","2"]', cwd: process.cwd(), title: 't', executors: ['codex'], status: 'queued', attempts: [], events: [],
      owner: 'scheduler', report: 'pending', projectId: 'p', createdAt: new Date().toISOString(),
      prompt: `Goal ${tokens(100000)}\n\nledger\n\n${tokens(330000)}\nContinue with the ready stages.` }];
  const { runtime } = await fixture({ state });
  const [t1, t2] = (await runtime.snapshot()).tasks;
  assert.equal(count(t1.prompt), 1); assert.match(t1.prompt, /^FRESH SESSION: .*520000 tokens[\s\S]*Local project restrictions: x$/);
  assert.equal(t1.basePrompt, 'Goal');
  assert.deepEqual(t1.ownerInstructions, ['please do X', 'then Y']);
  assert.equal(count(t2.prompt), 1); assert.match(t2.prompt, /330000 tokens/); assert.doesNotMatch(t2.prompt, /100000 tokens/);
});

test('handover helpers leave prompts without a handover untouched', () => {
  assert.equal(latestHandoverOnly('plain'), 'plain');
  assert.equal(stripHandovers('plain'), 'plain');
  const one = `${tokens(1)}\n\nbody`;
  assert.equal(latestHandoverOnly(one), one);
  assert.equal(stripHandovers(`${freshHandover('x')} The rejected result failed validation with: bad json\nbody`), 'body');
});
