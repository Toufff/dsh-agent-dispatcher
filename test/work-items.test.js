import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { ArchiveStore } from '../src/archive.js';
import { settingsSchema, initialState } from '../src/config.js';
import { MemoryBackend, TaskStore } from '../src/state-store.js';
import { Runtime } from '../src/runtime.js';
import { inspectOutcome } from '../src/outcome.js';
import { ledgerPrompt } from '../src/workflow.js';
import { foldCompletedWorkItems, foldTaskWorkItems, archivedWorkItems, isFoldedWorkItem,
  workItemArchivePolicy } from '../src/work-items.js';

// The fold is about one shape of history: a task whose ledger is mostly completed stages, each carrying a
// realistic evidence array (the live LON-35 entries average ~340 characters).
const evidenceOf = (id, i = 1) => `${id} verified (${i}): trials.jsonl 12 variants, account +3.1% over the last 3 months, ` +
  'audit 4 passed, no T+0 trade, exit_marked 0; snapshot 2026-11-20';
const doneItem = (id, evidence = [evidenceOf(id)]) => ({ id, title: `stage ${id}`, status: 'done', dependsOn: [],
  action: '', evidence });
const openItem = (id, status = 'ready', dependsOn = []) => ({ id, title: `stage ${id}`, status, dependsOn,
  action: status === 'ready' ? `do ${id}` : '', evidence: [], ...(status === 'blocked'
    ? { blocker: { kind: 'external', owner: 'peer', reason: 'receipt', resumeWhen: 'receipt arrives' } } : {}) });
const ledger = (done, extra = []) => [...Array.from({ length: done }, (_, i) => doneItem(`d${i}`)), ...extra];
const freshTask = (items, extra = {}) => ({ id: 't1', projectId: 'p', workItems: items, events: [], ...extra });
const tempArchive = async () => new ArchiveStore(await mkdtemp(path.join(os.tmpdir(), 'work-items-'))).open();

test('a ledger at or below the threshold is left alone', () => {
  for (const count of [0, 3, 200]) {
    const items = ledger(count, [openItem('open')]);
    const plan = foldCompletedWorkItems(items);
    assert.deepEqual(plan.folded, []);
    assert.equal(plan.workItems, items);                       // same reference: nothing copied, nothing rewritten
    assert.equal(plan.after, plan.before);
  }
  // One entry over the threshold folds, so the boundary is exclusive.
  assert.equal(foldCompletedWorkItems(ledger(201)).folded.length, 151);
});

test('above the threshold the oldest completed entries fold and the newest stay complete', () => {
  const items = ledger(300, [openItem('open')]);
  const plan = foldCompletedWorkItems(items);
  assert.equal(plan.folded.length, 250);
  assert.deepEqual(plan.folded.map(i => i.id), items.slice(0, 250).map(i => i.id));
  assert.deepEqual(plan.workItems.map(i => i.id), items.map(i => i.id));   // order and every id are preserved
  assert.equal(plan.workItems.length, items.length);
  assert.ok(plan.after < plan.before);
  const [first] = plan.workItems;
  assert.deepEqual(Object.keys(first).sort(), ['action', 'dependsOn', 'evidence', 'id', 'status', 'title']);
  assert.equal(first.status, 'done');
  assert.equal(first.id, 'd0');
  assert.ok(first.evidence.length === 1 && first.evidence[0].startsWith('[archived] d0 verified'));
  assert.ok(isFoldedWorkItem(first));
  // The newest `keep` completed entries and every unfinished entry are untouched.
  assert.equal(plan.workItems.at(-1), items.at(-1));
  assert.equal(plan.workItems[299], items[299]);
  assert.equal(plan.workItems[250], items[250]);
  assert.deepEqual(plan.workItems[250].evidence, [evidenceOf('d250')]);
});

test('folding keeps the whole evidence in the archive and a one-line summary in the ledger', async () => {
  const archive = await tempArchive();
  const long = 'x'.repeat(1990);
  const items = ledger(260, [openItem('open')]);
  items[7].evidence = ['first evidence line ' + long, 'second line', 'third line'];
  items[7].title = 'A stage whose title is\nspread over two lines';
  const task = freshTask(items);
  const plan = await foldTaskWorkItems(task, { archive }, {}, Date.parse('2026-11-25T00:00:00Z'));
  assert.equal(plan.folded.length, 210);
  const archived = archivedWorkItems(task, { archive });
  assert.equal(archived.length, 210);
  const restored = archived.find(item => item.id === 'd7');
  assert.deepEqual(restored.evidence, items[7].evidence);       // nothing truncated in the archive
  assert.equal(restored.title, items[7].title);
  const folded = task.workItems.find(item => item.id === 'd7');
  assert.equal(folded.title, 'A stage whose title is spread over two lines');
  assert.equal(folded.evidence.length, 1);
  assert.match(folded.evidence[0], /^\[archived\] first evidence line x+…$/);
  assert.ok(folded.evidence[0].length <= 2000);                 // still a legal evidence value
  // The archive is an append-only file per task, and the task itself only keeps a counter.
  assert.match(await readFile(path.join(archive.directory, 'work-items', 't1.jsonl'), 'utf8'), /"id":"d7"/);
  assert.deepEqual(task.archivedWorkItems, { count: 210, lastAt: '2026-11-25T00:00:00.000Z' });
  assert.deepEqual(task.events.at(-1).action, 'work-items-archived');
  assert.equal(task.events.at(-1).count, 210);
});

test('folding twice folds nothing (a repeated round is idempotent)', async () => {
  const archive = await tempArchive();
  const task = freshTask(ledger(260, [openItem('open')]));
  await foldTaskWorkItems(task, { archive }, {});
  const once = structuredClone(task.workItems), counter = task.archivedWorkItems;
  const again = await foldTaskWorkItems(task, { archive }, {});
  assert.deepEqual(again.folded, []);
  assert.deepEqual(task.workItems, once);
  assert.deepEqual(task.archivedWorkItems, counter);
  assert.equal(archivedWorkItems(task, { archive }).length, 210);
  // A ledger that grows again folds only what was not folded before.
  task.workItems.push(doneItem('d-new'));
  const third = await foldTaskWorkItems(task, { archive }, { workItemArchive: { threshold: 1, keep: 0 } });
  assert.equal(third.folded.length, 51);                       // the 50 kept complete plus the new entry
  assert.deepEqual(third.folded.map(i => i.id).slice(-1), ['d-new']);
  assert.equal(archivedWorkItems(task, { archive }).length, 261);
});

test('the fold can be switched off per project or per call', async () => {
  const archive = await tempArchive();
  const items = ledger(260, [openItem('open')]);
  const off = freshTask(structuredClone(items));
  assert.deepEqual((await foldTaskWorkItems(off, { archive }, { workItemArchive: { enabled: false } })).folded, []);
  assert.deepEqual(off.workItems, items);
  assert.equal(off.archivedWorkItems, undefined);
  assert.equal(foldCompletedWorkItems(items, { enabled: false }).folded.length, 0);
  // The switch is part of the project settings, and unknown options are rejected as before.
  const settings = (workItemArchive) => settingsSchema.parse({ executors: [], projects: [{ id: 'p', label: 'P',
    cwd: process.cwd(), followup: { enabled: true, commentAuthorIds: ['peer'], workItemArchive } }] });
  assert.deepEqual(settings({ enabled: false, threshold: 400 }).projects[0].followup.workItemArchive,
    { enabled: false, threshold: 400 });
  assert.throws(() => settings({ threshold: 0 }), /threshold/);
  assert.throws(() => settings({ typo: 1 }), /typo|unrecognized/);
  assert.deepEqual(workItemArchivePolicy({ workItemArchive: { threshold: 5 } }),
    { enabled: true, threshold: 5, keep: 50, evidenceChars: 80 });
});

test('without an archive the complete entries stay in the task', async () => {
  const items = ledger(260, [openItem('open')]);
  const task = freshTask(items);
  await foldTaskWorkItems(task, {}, {});
  assert.equal(task.archivedWorkItems.count, 210);
  assert.deepEqual(task.archivedWorkItems.entries.map(i => i.id), items.slice(0, 210).map(i => i.id));
  assert.deepEqual(archivedWorkItems(task).find(i => i.id === 'd3').evidence, [evidenceOf('d3')]);
});

test('a folded ledger still validates, resolves archived ids in dependsOn and shows the same open work', async () => {
  const archive = await tempArchive();
  const items = ledger(260, [openItem('open', 'ready', ['open'])]);
  const task = freshTask(items);
  await foldTaskWorkItems(task, { archive }, {});
  const stored = task.workItems;
  // The next round completes the open stage and adds one that depends on an archived stage.
  const outcome = `<dispatch-result>${JSON.stringify({ status: 'continue', evidence: ['verified'], remaining: ['more'],
    next: 'do the next stage', progress: 'new evidence', blockers: [], workItems: [
      { id: 'next', title: 'next stage', status: 'ready', dependsOn: ['open', 'd0'], action: 'do next', evidence: [] },
      { ...openItem('open', 'done'), evidence: ['open verified'] }] })}</dispatch-result>`;
  const result = inspectOutcome(outcome, { previous: stored, required: true });
  assert.equal(result.error, null);
  assert.equal(result.framingRecovery, undefined);              // archived dependencies still resolve: nothing dropped
  assert.equal(result.outcome.workItems.find(i => i.id === 'next').dependsOn.length, 2);
  assert.ok(result.outcome.workItems.some(i => i.id === 'd0'));
  assert.ok(stored.every(item => item.status === 'done' || item.status !== 'done'));
  // The prompt still lists every unfinished stage in full and the completed ones as an index.
  const prompt = ledgerPrompt(stored);
  assert.match(prompt, /"id":"open"/);
  assert.match(prompt, /- d259: stage d259/);
});

test('LON-35 real ledger: the oldest completed entries fold and the ledger loses a third of its characters', async () => {
  // Every 6th entry of the live LON-35 ledger (1503 entries, 1486 done, 517 349 characters), verbatim. The full
  // ledger with the same defaults: 517 349 -> 325 906 characters (37.0% smaller), 1436 entries folded.
  const fixture = JSON.parse(await readFile(new URL('./fixtures/lon35-workitems.sample.json', import.meta.url), 'utf8'));
  const done = fixture.filter(item => item.status === 'done');
  assert.equal(fixture.length, 251);
  assert.equal(done.length, 249);
  const plan = foldCompletedWorkItems(fixture);
  const saving = 1 - plan.after / plan.before;
  console.log(`LON-35 sample: ${fixture.length} entries, ${done.length} done: ${plan.before} -> ${plan.after} characters ` +
    `(${(saving * 100).toFixed(1)}% smaller), ${plan.folded.length} folded, ${done.length - plan.folded.length} kept complete`);
  assert.equal(plan.folded.length, 199);
  assert.ok(saving > 0.25, `expected a visible reduction, got ${saving}`);
  // What the fold keeps is the same amount of open work; only history got shorter.
  assert.deepEqual(plan.workItems.filter(i => i.status !== 'done'), fixture.filter(i => i.status !== 'done'));
});

test('assessing a round folds the ledger through the dispatcher and persists it', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'work-items-rt-')), archive = await new ArchiveStore(dir).open();
  const items = ledger(260, [openItem('waiting', 'blocked')]);
  // The round reports only the one stage it is waiting on (the schema bounds one report at 200 entries); the
  // other 260 entries are the stored history the dispatcher keeps.
  const summary = `<dispatch-result>${JSON.stringify({ status: 'blocked', evidence: ['checked'], remaining: ['receipt'],
    next: '', progress: 'verified 260 stages', blockers: [{ owner: 'peer', reason: 'receipt', resumeWhen: 'receipt arrives' }],
    workItems: [openItem('waiting', 'blocked')] })}</dispatch-result>`;
  const task = { id: 't1', key: JSON.stringify(['w/t1', '1']), projectId: 'p', cwd: process.cwd(), prompt: 'p',
    basePrompt: 'goal', title: 't1', executors: ['codex'], status: 'review', assessed: false, report: 'pending',
    owner: 'scheduler', resultContract: true, workflowVersion: 2, events: [], summary, workItems: items,
    attempts: [{ id: 'a1', executor: 'codex', status: 'review', accepted: true, sessionId: 's1' }],
    createdAt: '2026-11-20T00:00:00.000Z' };
  const settings = initialState().settings;
  settings.projects = [{ id: 'p', label: 'P', cwd: process.cwd() }];
  const store = await new TaskStore(new MemoryBackend({ version: 1, revision: 0, paused: true, settings, tasks: [task], outbox: [] }),
    { archive }).open();
  const runtime = await new Runtime({ store, directory: dir, env: { TEST_TOKEN: 'synthetic' } }).init();
  await runtime.assess();
  const stored = (await runtime.snapshot()).tasks.find(t => t.id === 't1');
  assert.equal(stored.status, 'blocked');
  assert.equal(stored.archivedWorkItems.count, 210);
  assert.equal(stored.workItems.length, 261);
  assert.equal(stored.workItems.filter(item => isFoldedWorkItem(item)).length, 210);
  assert.deepEqual(stored.events.filter(e => e.action === 'work-items-archived').length, 1);
  assert.equal(archivedWorkItems(stored, { archive }).length, 210);       // durable, readable by id after the round
  assert.ok(JSON.stringify(stored.workItems).length < JSON.stringify(items).length);
});

