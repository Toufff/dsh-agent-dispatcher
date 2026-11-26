// The declarative status table (src/states.js) must cover every task status the code can produce or compare, and
// no module may keep its own literal list of task statuses again (3.2: 'manual' was missing from one such list).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { TASK_STATES, TASK_STATUSES, terminal, is, statusesWith } from '../src/states.js';
import { terminal as dispatcherTerminal, MemoryStore } from '../src/dispatcher.js';
import { initialState } from '../src/config.js';
import { Runtime } from '../src/runtime.js';

const SRC = path.join(import.meta.dirname, '..', 'src');
async function sources(dir = SRC) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await sources(file));
    else if (/\.(js|jsx)$/.test(entry.name)) out.push({ file: path.relative(SRC, file), text: await readFile(file, 'utf8') });
  }
  return out;
}
// Variables that hold a task record in src/ (attempt, wait, outbox, item, receipt and result statuses are other
// namespaces with their own values).
const TASK_VARS = '(?:task|live|prior|target|next|other|o|t)';
const strings = text => [...text.matchAll(/'([a-z_]+)'/g)].map(m => m[1]);

test('every task status assigned or compared anywhere in src has a table entry', async () => {
  const found = new Map();
  const note = (status, where) => { if (!found.has(status)) found.set(status, where); };
  for (const { file, text } of await sources()) {
    if (file === 'states.js') continue;
    // Assignments: task.status = <expression up to the end of the statement>, including ternaries and maps.
    for (const m of text.matchAll(new RegExp(`\\b${TASK_VARS}\\.status\\s*=(?!=)([^;]*?)(?:;|\\n\\s*\\n)`, 'gs')))
      for (const s of strings(m[1].replace(/\b(?:(?:outcome|result|attempt|wait|item|i)\??\.status|action)\s*[!=]==\s*'[a-z_]+'/g, ''))) note(s, `${file}: ${m[0].slice(0, 60)}`);
    // Comparisons: task.status === 'x' / !== 'x'.
    for (const m of text.matchAll(new RegExp(`\\b${TASK_VARS}\\??\\.status\\s*[!=]==\\s*'([a-z_]+)'`, 'g'))) note(m[1], `${file}: ${m[0]}`);
    // The new-task literal in Dispatcher.enqueue.
    for (const m of text.matchAll(/status: '([a-z_]+)', attempts:/g)) note(m[1], `${file}: ${m[0]}`);
  }
  // The comparison scan must actually see the code (guards the regexes themselves).
  for (const s of ['queued', 'stopping', 'manual', 'blocked', 'review', 'needs_result', 'exhausted']) assert.ok(found.has(s), `scan missed ${s}`);
  const missing = [...found].filter(([s]) => !TASK_STATES[s]);
  assert.deepEqual(missing, [], `undeclared task statuses: ${JSON.stringify(missing)}`);
});

test('no module keeps its own literal list of task statuses', async () => {
  const offenders = [];
  for (const { file, text } of await sources()) {
    if (file === 'states.js') continue;
    for (const m of text.matchAll(new RegExp(`\\[(?:'[a-z_]+',\\s*)+'[a-z_]+'\\]\\.includes\\(${TASK_VARS}\\.status\\)`, 'g'))) offenders.push(`${file}: ${m[0]}`);
    for (const m of text.matchAll(/new Set\(\[([^\]]*)\]\)/g)) {
      const listed = strings(m[1]);
      if (listed.length > 1 && listed.every(s => TASK_STATES[s])) offenders.push(`${file}: ${m[0]}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test('properties named by callers exist in the table', async () => {
  const known = new Set(TASK_STATUSES.flatMap(s => Object.keys(TASK_STATES[s])));
  const used = new Set();
  for (const { text } of await sources())
    for (const m of text.matchAll(/\b(?:is|has|statusesWith|property)\((?:[^()]*?,\s*)?'([a-zA-Z]+)'\)/g)) used.add(m[1]);
  assert.ok(used.size >= 10, `scan saw only ${[...used]}`);
  assert.deepEqual([...used].filter(p => !known.has(p)), []);
});

test('table invariants: manual is terminal; slot holders are exactly the non-terminal non-queued statuses', () => {
  assert.ok(is('manual', 'terminal'));
  assert.equal(dispatcherTerminal, terminal);
  for (const s of TASK_STATUSES) {
    assert.equal(is(s, 'holdsSlot'), !is(s, 'terminal') && s !== 'queued', s);
    assert.ok(['requeue', 'reconcile', 'settled'].includes(TASK_STATES[s].afterRestart), s);
    assert.equal(TASK_STATES[s].afterRestart === 'reconcile', is(s, 'holdsSlot'), s);
    if (is(s, 'executing')) assert.ok(!is(s, 'terminal'), s);
    for (const p of ['continuable', 'retryable', 'armable', 'commentResumable', 'dataWake']) if (is(s, p)) assert.ok(is(s, 'terminal'), `${s} ${p}`);
  }
  assert.deepEqual(statusesWith('retryable'), ['stopped', 'failed', 'exhausted']);
  assert.throws(() => is('nonsense', 'terminal'), /Undeclared/);
});

test('configure is not blocked by manual (human-owned) tasks', async () => {
  const store = new MemoryStore(), state = initialState();
  state.settings.projects = [{ id: 'p', label: 'P', cwd: process.cwd() }];
  state.tasks = [{ id: 'm', key: '["s","1"]', cwd: process.cwd(), projectId: 'p', status: 'manual', owner: 'human', attempts: [], events: [], executors: ['codex'] }];
  await store.save(state);
  const runtime = await new Runtime({ store, directory: os.tmpdir(), env: {} }).init();
  const snap = await runtime.snapshot();
  const settings = structuredClone(snap.settings);
  settings.projects[0].label = 'Renamed'; settings.projects[0].cwd = os.tmpdir();
  await runtime.configure(settings, snap.revision);
  assert.equal((await runtime.snapshot()).settings.projects[0].cwd, os.tmpdir());
});
