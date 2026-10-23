// Opt-in: real Codex and persistence, simulated Linear transport and identities.
// No real Linear token, issue, receiving host, or production store is used.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FileStore } from '../src/store.js';
import { initialState } from '../src/config.js';
import { Runtime } from '../src/runtime.js';
import { LinearClient } from '../src/linear.js';

export async function runSimulatedPeer({ directory, adapter, pollMs = 500, onStage = () => {} }) {
  // A new evidence directory is mandatory; never replay a previous task.
  await mkdir(directory, { recursive: false });
  let store = await new FileStore(directory).open();
  const receipt = { mode: adapter ? 'simulated-executor-and-linear' : 'real-codex-simulated-linear', stages: [], startedAt: new Date().toISOString() };
  const stage = name => { receipt.stages.push(name); onStage(name); };
  const marker = 'SIMULATED_PEER_ACK';
  const result = waiting => `<dispatch-result>${JSON.stringify({ status: waiting ? 'blocked' : 'complete', evidence: [waiting ? 'listener ready' : marker], remaining: waiting ? ['simulated reply'] : [], next: waiting ? 'Verify simulated reply' : '', progress: waiting ? 'listener registered' : 'simulated reply verified', blockers: waiting ? [{ owner: 'test peer', reason: 'awaiting fixture', resumeWhen: marker }] : [], ...(waiting ? { wait: { kind: 'linear', issueId: 'child', condition: `Verify ${marker}; no tools` } } : {}) })}</dispatch-result>`;
  const description = `ISOLATED SIMULATION. No tools, commands, browsing or file writes. If the CURRENT message says External condition changed and its observed comment body contains ${marker}, return exactly ${result(false)}. Otherwise return exactly ${result(true)}. A simulated reply never authorizes production work.`;
  const remote = { state: 'active', comments: [], reports: new Map(), writes: new Map(), offline: false };
  let calls = 0;
  const fetcher = async (url, options) => {
    assert.equal(url, 'https://api.linear.app/graphql');
    assert.equal(options.headers.Authorization, 'synthetic');
    calls++;
    const { query, variables: v } = JSON.parse(options.body);
    const pageInfo = { hasNextPage: false, endCursor: null };
    let data;
    if (query.includes('organization')) data = { organization: { id: 'workspace' } };
    else if (query.includes('issues(filter:')) data = { issues: { nodes: [{ id: 'parent', identifier: 'SIM-1', title: 'Simulated collaborator acceptance', description, url: 'https://linear.app/example/issue/SIM-1' }], pageInfo } };
    else if (query.includes('commentCreate')) {
      assert.equal(v.input.issueId, 'parent');
      remote.writes.set(v.input.id, (remote.writes.get(v.input.id) || 0) + 1);
      remote.reports.set(v.input.id, v.input);
      data = { commentCreate: { success: true } };
    } else if (query.includes('issueUpdate')) {
      assert.equal(v.id, 'parent'); assert.notEqual(v.input.stateId, 'done');
      remote.state = v.input.stateId; data = { issueUpdate: { success: true } };
    } else if (query.includes('body createdAt')) {
      if (remote.offline) return { ok: false, status: 503 };
      assert.equal(v.id, 'child');
      data = { issue: { id: 'child', identifier: 'SIM-2', project: { id: 'project' }, parent: { id: 'parent' }, state: { type: 'started' }, comments: { nodes: remote.comments, pageInfo } } };
    } else if (query.includes('comments(first:')) {
      assert.equal(v.id, 'parent');
      data = { issue: { state: { type: 'started', id: remote.state }, comments: { nodes: [...remote.reports.values()], pageInfo } } };
    } else if (query.includes('assignee')) {
      assert.equal(v.id, 'parent');
      data = { issue: { id: 'parent', project: { id: 'project' }, assignee: { id: 'owner' }, state: { type: 'started' } } };
    } else throw new Error('Unexpected simulated GraphQL operation');
    return { ok: true, json: async () => ({ data }) };
  };
  let runtime;
  const make = async () => {
    runtime = await new Runtime({ store, directory, env: { DISPATCH_LINEAR_SIMULATED: 'synthetic' }, linearFactory: token => new LinearClient(token, fetcher) }).init();
    if (adapter) runtime.adapters.codex = adapter({ blocked: result(true), complete: result(false) });
  };
  const settle = async expected => {
    const deadline = Date.now() + 180000;
    while (Date.now() < deadline) {
      await runtime.dispatcher.tick(); await runtime.dispatcher.reconcile(); await runtime.assess(); await runtime.report();
      const t = (await store.load()).tasks[0];
      if (t?.status === expected && t.assessed && t.report === 'sent') return t;
      if (['failed', 'stalled', 'decision', 'exhausted'].includes(t?.status)) throw new Error(`Unexpected executor status: ${t.status}`);
      await new Promise(resolve => setTimeout(resolve, pollMs));
    }
    throw new Error(`Timed out waiting for ${expected}; evidence preserved, do not replay`);
  };
  try {
    const state = initialState(); state.paused = false;
    state.settings.executors = [{ id: 'codex', type: 'codex', label: 'Codex simulation', command: process.env.DISPATCH_SMOKE_COMMAND || 'codex', args: [], sandbox: 'read-only', enabled: true }];
    state.settings.projects = [{ id: 'acceptance-simulated-peer', label: 'Isolated simulation', cwd: directory,
      followup: { enabled: true, commentAuthorIds: ['owner', 'peer'], maxWakeups: 3 },
      linear: { enabled: true, workspaceId: 'workspace', projectId: 'project', assigneeId: 'owner', readyStateId: 'ready', activeStateId: 'active', reviewStateId: 'review', tokenEnv: 'DISPATCH_LINEAR_SIMULATED', since: '2000-01-01T00:00:00Z', round: '1' } }];
    await store.save(state); await make(); await runtime.intake(); await runtime.intake();
    const first = await settle('blocked');
    assert.equal(first.wait.status, 'watching');
    const session = first.attempts.at(-1).sessionId;
    stage('initial execution blocked with original session');
    const comment = (id, author) => ({ id, user: { id: author }, body: marker, updatedAt: new Date(Date.now() + 1000).toISOString() });
    remote.comments.push(comment('own-control', 'owner'), comment('stranger-control', 'stranger'));
    await runtime.monitor(); await runtime.dispatcher.tick();
    assert.equal((await store.load()).tasks[0].status, 'blocked');
    assert.equal((await store.load()).tasks[0].wakeups || 0, 0);
    stage('owner and untrusted comments ignored');
    await store.close(); store = await new FileStore(directory).open(); await make();
    remote.offline = true; await runtime.monitor();
    assert.ok((await store.load()).tasks[0].wait.error);
    remote.offline = false; remote.comments.push(comment('peer-ack', 'peer'));
    await Promise.all([runtime.monitor(), runtime.monitor()]);
    const queued = (await store.load()).tasks[0];
    assert.equal(queued.status, 'queued'); assert.equal(queued.session.id, session);
    assert.equal(queued.wakeups, 1);
    stage('trusted simulated reply queued exactly once after restart and outage');
    // Restart again AFTER durable event consumption but BEFORE executing it.
    await store.close(); store = await new FileStore(directory).open(); await make();
    const final = await settle('review');
    const attempts = [...(final.previousAttempts || []), ...final.attempts].filter(a => a.accepted);
    assert.equal(attempts.length, 2); assert.ok(attempts.every(a => a.sessionId === session));
    assert.equal(final.outcome.status, 'complete'); assert.equal(final.wakeups, 1); assert.equal(remote.state, 'review');
    for (let i = 0; i < 3; i++) { await runtime.intake(); await runtime.monitor(); await runtime.dispatcher.tick(); await runtime.report(); }
    const end = await store.load();
    assert.equal(end.tasks.length, 1);
    assert.deepEqual(end.tasks[0].attempts, final.attempts);
    assert.ok(end.outbox.every(item => item.status === 'sent' && remote.reports.has(item.id)));
    assert.ok([...remote.writes.values()].every(count => count === 1));
    stage('same-session completion and report readback; repeated polling creates no duplicates');
    Object.assign(receipt, { result: 'passed', sessionId: session, acceptedAttempts: attempts.length, wakeups: final.wakeups, reports: remote.reports.size, mockGraphqlCalls: calls, realCrossAccountVerified: false });
    return receipt;
  } catch (error) { receipt.result = 'failed'; receipt.error = error.message; throw error; }
  finally {
    receipt.finishedAt = new Date().toISOString();
    await writeFile(path.join(directory, 'receipt.json'), JSON.stringify(receipt, null, 2));
    await store.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] !== '--execute' || !process.argv[3]) console.log('Usage: node scripts/simulated-peer-acceptance.js --execute /new/private/evidence-directory');
  else console.log(JSON.stringify(await runSimulatedPeer({ directory: path.resolve(process.argv[3]), onStage: stage => console.log(stage) })));
}
