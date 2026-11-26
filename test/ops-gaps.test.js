import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { acquireLease, lockStaleness, ownProcess } from '../src/host-lease.js';
import { DshAdapter, isSystemNotice } from '../src/adapters/dsh.js';
import { Dispatcher, MemoryStore } from '../src/dispatcher.js';

// ---- 1. stale host.lock takeover ----

const T0 = Date.parse('2030-01-01T00:00:00Z');
const self = { pid: 4242, processStartedAt: new Date(T0 + 3_600_000).toISOString() };
const dir = () => mkdtemp(path.join(os.tmpdir(), 'lease-'));
const writeLock = (d, lock) => writeFile(path.join(d, 'host.lock'), JSON.stringify(lock));
const readLock = async d => JSON.parse(await readFile(path.join(d, 'host.lock'), 'utf8'));
const auditLines = async d => (await readFile(path.join(d, 'host-lock-audit.log'), 'utf8').catch(() => '')).split('\n').filter(Boolean).map(l => JSON.parse(l));
const exists = file => access(file).then(() => true, () => false);

test('lease: fresh lock records pid and process start time; release removes it', async () => {
  const d = await dir();
  const release = await acquireLease(d, { self, probe: async () => assert.fail('no probe without a lock') });
  const lock = await readLock(d);
  assert.equal(lock.pid, 4242); assert.equal(lock.processStartedAt, self.processStartedAt); assert.ok(lock.startedAt);
  await release();
  assert.equal(await exists(path.join(d, 'host.lock')), false);
  await rm(d, { recursive: true });
});

test('lease: a dead owner is taken over and audited', async () => {
  const d = await dir();
  await writeLock(d, { pid: 111, startedAt: new Date(T0).toISOString() });
  const logs = [];
  const release = await acquireLease(d, { self, probe: async pid => (assert.equal(pid, 111), { alive: false }), log: m => logs.push(m) });
  assert.equal((await readLock(d)).pid, 4242);
  const [line] = await auditLines(d);
  assert.equal(line.action, 'host-lock-takeover'); assert.equal(line.reason, 'owner-dead'); assert.equal(line.previous.pid, 111);
  assert.equal(logs.length, 1);
  assert.equal(await exists(path.join(d, 'host.lock.takeover')), false, 'mutex released');
  await release(); await rm(d, { recursive: true });
});

test('lease: a live owner with the recorded start time is refused, lock untouched', async () => {
  const d = await dir();
  const owner = { pid: 222, startedAt: new Date(T0 + 5000).toISOString(), processStartedAt: new Date(T0).toISOString() };
  await writeLock(d, owner);
  await assert.rejects(acquireLease(d, { self, probe: async () => ({ alive: true, startedAt: T0 + 400 }) }), /host lock exists \(owner alive\)/);
  assert.deepEqual(await readLock(d), owner);
  assert.deepEqual(await auditLines(d), []);
  await rm(d, { recursive: true });
});

test('lease: Windows PID reuse (alive pid, different start time) is taken over', async () => {
  const d = await dir();
  await writeLock(d, { pid: 333, startedAt: new Date(T0 + 1000).toISOString(), processStartedAt: new Date(T0).toISOString() });
  const release = await acquireLease(d, { self, probe: async () => ({ alive: true, startedAt: T0 + 86_400_000 }) });
  assert.equal((await readLock(d)).pid, 4242);
  assert.equal((await auditLines(d))[0].reason, 'pid-reused');
  await release(); await rm(d, { recursive: true });
});

test('lease: legacy lock without start time — reused only when the process started after the lock was written', async () => {
  const legacy = { pid: 444, startedAt: new Date(T0).toISOString() };
  assert.deepEqual(await lockStaleness(legacy, async () => ({ alive: true, startedAt: T0 - 60_000 })), { stale: false, reason: 'owner alive' });
  assert.equal((await lockStaleness(legacy, async () => ({ alive: true, startedAt: T0 + 60_000 }))).reason, 'pid-reused');
  // the live production host: alive, start time unknown -> never stale
  assert.equal((await lockStaleness(legacy, async () => ({ alive: true }))).stale, false);
  assert.equal((await lockStaleness({ pid: -1 }, async () => assert.fail())).stale, false);
  // our own pid in an old lock (pid reuse by this very process after a reboot) is stale by start time
  assert.equal((await lockStaleness({ pid: 4242, startedAt: new Date(T0).toISOString(), processStartedAt: new Date(T0).toISOString() },
    async () => ({ alive: true, startedAt: Date.parse(self.processStartedAt) }))).reason, 'pid-reused');
});

test('lease: unreadable lock and a fresh takeover mutex are refused; a stale mutex is cleared', async () => {
  const d = await dir();
  await writeFile(path.join(d, 'host.lock'), '');
  await assert.rejects(acquireLease(d, { self, probe: async () => ({ alive: false }) }), /unreadable lock record/);
  await writeLock(d, { pid: 555, startedAt: new Date(T0).toISOString() });
  await writeFile(path.join(d, 'host.lock.takeover'), 'x');
  await assert.rejects(acquireLease(d, { self, probe: async () => ({ alive: false }) }), /Another host is taking over/);
  // the mutex is 0s old in real time; a clock 2 minutes ahead makes it stale
  const release = await acquireLease(d, { self, now: () => Date.now() + 120_000, probe: async () => ({ alive: false }) });
  assert.equal((await readLock(d)).pid, 4242);
  await release(); await rm(d, { recursive: true });
});

test('lease: two hosts racing over one stale lock — exactly one wins', async () => {
  const d = await dir();
  await writeLock(d, { pid: 666, startedAt: new Date(T0).toISOString() });
  // A judges stale, but while A waits for the probe B takes over; A must re-judge B's fresh lock and refuse.
  let releaseB;
  const probeA = async pid => {
    if (pid === 666) { releaseB = await acquireLease(d, { self: { pid: 7777, processStartedAt: new Date(T0).toISOString() }, probe: async () => ({ alive: false }) }); return { alive: false }; }
    return { alive: true, startedAt: T0 };   // B is alive and is the recorded process
  };
  await assert.rejects(acquireLease(d, { self, probe: probeA }), /host lock exists/);
  assert.equal((await readLock(d)).pid, 7777);
  assert.equal((await auditLines(d)).length, 1);
  await releaseB(); await rm(d, { recursive: true });
});

// ---- 2. busy session held by residual queued system notices ----

const notice = (id, kind = 'tool-jobs', target) => ({ id, source: { kind }, content: [], target });
function fakeAgent({ nextTurn = [], nextStep = [], status = 'idle', removeFails = false } = {}) {
  const agent = { status, removed: [], inbox: { nextTurn, nextStep,
    remove(id) { if (removeFails) throw new Error('nope'); agent.removed.push(id);
      this.nextTurn = this.nextTurn.filter(m => m.id !== id); this.nextStep = this.nextStep.filter(m => m.id !== id); } } };
  return agent;
}
const clock = () => { const c = { t: T0, now: () => c.t }; return c; };
const busy = { attempt: { id: 'a1', status: 'busy', sessionId: 's1' } };

test('system notice classification is exact: listed kind, no rpcId, no principal', () => {
  assert.equal(isSystemNotice(notice('n')), true);
  assert.equal(isSystemNotice({ id: 'x', source: { kind: 'tool-jobs', rpcId: 'r' } }), false);
  assert.equal(isSystemNotice({ id: 'x', source: { kind: 'time-context', principal: { kind: 'peer' } } }), false);
  for (const kind of ['user', 'schedule', 'tool-goal', 'user-approval', 'user-question-reply', 'cordis-host-runner', 'system', undefined])
    assert.equal(isSystemNotice({ id: 'x', source: { kind } }), false, String(kind));
});

test('residual system notices are removed only after the idle threshold', async () => {
  const c = clock();
  const agent = fakeAgent({ nextTurn: [notice('n1'), notice('n2', 'time-context')] });
  const adapter = new DshAdapter({ agents: { get: () => agent } }, { residualNoticeMinutes: 10 }, { now: c.now });
  assert.deepEqual(await adapter.reconcile(structuredClone(busy)), { status: 'busy' });
  c.t += 9 * 60_000;
  assert.deepEqual(await adapter.reconcile(structuredClone(busy)), { status: 'busy' });
  assert.deepEqual(agent.removed, []);
  c.t += 2 * 60_000;
  const result = await adapter.reconcile(structuredClone(busy));
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.cleared.map(i => [i.id, i.kind, i.target]), [['n1', 'tool-jobs', 'nextTurn'], ['n2', 'time-context', 'nextTurn']]);
  assert.deepEqual(agent.removed, ['n1', 'n2']);
});

test('an active turn resets the residual clock and nothing is removed', async () => {
  const c = clock();
  const agent = fakeAgent({ nextTurn: [notice('n1')] });
  const adapter = new DshAdapter({ agents: { get: () => agent } }, {}, { now: c.now });
  await adapter.reconcile(structuredClone(busy));
  c.t += 30 * 60_000; agent.status = 'running';
  assert.deepEqual(await adapter.reconcile(structuredClone(busy)), { status: 'busy' });
  agent.status = 'idle';
  c.t += 60_000;
  assert.deepEqual(await adapter.reconcile(structuredClone(busy)), { status: 'busy' }, 'clock restarted after the turn');
  assert.deepEqual(agent.removed, []);
});

test('ambiguous queued items (a user prompt, an unknown kind) are left in place and reported stuck', async () => {
  const c = clock();
  const agent = fakeAgent({ nextTurn: [notice('n1'), { id: 'u1', source: { kind: 'user', rpcId: 'manual' } }], nextStep: [notice('k', 'schedule')] });
  const adapter = new DshAdapter({ agents: { get: () => agent } }, { residualNoticeMinutes: 1 }, { now: c.now });
  await adapter.reconcile(structuredClone(busy));
  c.t += 2 * 60_000;
  const result = await adapter.reconcile(structuredClone(busy));
  assert.equal(result.status, 'busy');
  assert.equal(result.stuck.reason, 'ambiguous-queued-items');
  assert.deepEqual(result.stuck.items.map(i => i.kind), ['tool-jobs', 'user']);   // non-user nextStep never blocks
  assert.deepEqual(agent.removed, []);
});

test('a failing queue removal is surfaced, not retried as ready', async () => {
  const c = clock();
  const agent = fakeAgent({ nextTurn: [notice('n1')], removeFails: true });
  const adapter = new DshAdapter({ agents: { get: () => agent } }, { residualNoticeMinutes: 0 }, { now: c.now });
  const result = await adapter.reconcile(structuredClone(busy));
  assert.equal(result.status, 'busy'); assert.equal(result.stuck.reason, 'queue-removal-failed');
});

const input = { source: 'example-workspace/example-issue', round: '1', cwd: '/example/project', prompt: 'Synthetic fixture', executors: ['first'] };

test('dispatcher: cleared notices requeue the busy task and record an event; ambiguous ones mark the attempt stuck', async () => {
  const store = new MemoryStore();
  let next = { status: 'busy', stuck: { since: '2030-01-01T00:00:00.000Z', reason: 'ambiguous-queued-items', items: [{ id: 'u1', kind: 'user', target: 'nextTurn' }] } };
  const dispatcher = new Dispatcher({ store, adapters: { first: {
    start: async () => ({ status: 'busy', reason: 'Session already has active or queued work' }),
    reconcile: async () => next,
  } } });
  await dispatcher.enqueue(input);
  await dispatcher.tick();
  assert.equal((await store.load()).tasks[0].status, 'busy');
  await dispatcher.reconcile(); await dispatcher.reconcile();
  let task = (await store.load()).tasks[0];
  assert.equal(task.status, 'busy');
  assert.deepEqual(task.attempts.at(-1).stuck, { since: '2030-01-01T00:00:00.000Z', reason: 'ambiguous-queued-items', items: [{ kind: 'user', target: 'nextTurn' }] });
  assert.equal(task.events.filter(e => e.action === 'residual-queue-ambiguous').length, 1, 'recorded once');
  next = { status: 'busy' };
  await dispatcher.reconcile();
  assert.equal((await store.load()).tasks[0].attempts.at(-1).stuck, undefined);
  next = { status: 'ready', cleared: [{ id: 'n1', kind: 'tool-jobs', target: 'nextTurn' }] };
  await dispatcher.reconcile();
  task = (await store.load()).tasks[0];
  assert.equal(task.status, 'queued'); assert.equal(task.attempts.length, 0);
  const event = task.events.find(e => e.action === 'residual-notices-cleared');
  assert.deepEqual(event.items, [{ id: 'n1', kind: 'tool-jobs', target: 'nextTurn' }]);
});

test('snapshot: a busy task with an ambiguous residual queue shows an error; a plain busy task does not', async () => {
  const { Runtime } = await import('../src/runtime.js');
  const { initialState } = await import('../src/config.js');
  const store = new MemoryStore(), state = initialState();
  state.settings.projects = [{ id: 'p', label: 'Example', cwd: process.cwd() }];
  await store.save(state);
  const runtime = await new Runtime({ store, directory: os.tmpdir() }).init();
  let next = { status: 'busy' };
  runtime.adapters.codex = { start: async () => ({ status: 'busy', reason: 'queued work' }), reconcile: async () => next };
  await runtime.submit({ projectId: 'p', prompt: 'Example' });
  await runtime.dispatcher.update(s => { s.paused = false; });
  await runtime.dispatcher.tick(); await runtime.dispatcher.reconcile();
  const residual = s => s.errors.filter(e => e.includes('无法确认为系统通知'));
  assert.equal((await runtime.snapshot()).tasks[0].status, 'busy');
  assert.deepEqual(residual(await runtime.snapshot()), []);
  next = { status: 'busy', stuck: { since: '2030-01-01T00:00:00.000Z', reason: 'ambiguous-queued-items', items: [{ id: 'u', kind: 'user', target: 'nextTurn' }] } };
  await runtime.dispatcher.reconcile();
  const [error] = residual(await runtime.snapshot());
  assert.match(error, /user@nextTurn/); assert.match(error, /ambiguous-queued-items/);
});

// ---- review findings (accept3) ----

test('lease: own start time comes from the same probe a later host uses; release never removes a lock it no longer owns', async () => {
  const started = T0 + 5_000;
  const me = await ownProcess(async pid => (assert.equal(pid, process.pid), { alive: true, startedAt: started }));
  assert.equal(me.processStartedAt, new Date(started).toISOString());
  // Probe unavailable: falls back to the uptime estimate.
  assert.ok(Date.parse((await ownProcess(async () => { throw new Error('no ps'); })).processStartedAt) <= Date.now());
  // A recorded start time within the widened tolerance (clock step) is still the same live process.
  assert.equal((await lockStaleness({ pid: 9, processStartedAt: new Date(T0).toISOString() }, async () => ({ alive: true, startedAt: T0 + 3_000 }))).stale, false);
  const d = await dir();
  const release = await acquireLease(d, { self, probe: async () => assert.fail('no probe') });
  const other = { pid: 5151, processStartedAt: new Date(T0).toISOString(), startedAt: new Date(T0).toISOString() };
  await writeLock(d, other);                    // another host took the lock over meanwhile
  await release();
  assert.deepEqual(await readLock(d), other, 'the other host\'s lock is kept');
  await rm(d, { recursive: true });
});

test('residual cleanup keeps the text of removed tool-jobs notices in the cleared record', async () => {
  const c = clock();
  const job = { id: 'j1', source: { kind: 'tool-jobs' }, content: [{ type: 'text', text: 'job 7 finished: 3 files written' }] };
  const agent = fakeAgent({ nextTurn: [job] });
  const adapter = new DshAdapter({ agents: { get: () => agent } }, { residualNoticeMinutes: 1 }, { now: c.now });
  await adapter.reconcile(structuredClone(busy));
  c.t += 2 * 60_000;
  const result = await adapter.reconcile(structuredClone(busy));
  assert.equal(result.status, 'ready');
  assert.equal(result.cleared[0].text, 'job 7 finished: 3 files written');
});
