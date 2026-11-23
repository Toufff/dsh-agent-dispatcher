import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { LinearClient, linearMapping, assigneeAllowed } from '../src/linear.js';
import { MemoryStore } from '../src/dispatcher.js';
import { initialState, settingsSchema } from '../src/config.js';
import { Runtime } from '../src/runtime.js';

const mapping = { workspaceId: 'w', projectId: 'proj', assigneeId: 'me', readyStateId: 'todo', reviewStateId: 'review',
  tokenEnv: 'TEST_TOKEN', enabled: true, since: '2026-01-01T00:00:00.000Z', round: '1' };
const project = { id: 'p', label: 'Example', cwd: process.cwd(), linear: mapping };

function recordingClient(issueFor) {
  const filters = [];
  const client = new LinearClient('synthetic', async (url, request) => {
    const { query, variables } = JSON.parse(request.body);
    let data;
    if (query.includes('organization')) data = { organization: { id: 'w' } };
    else if (query.includes('issues(')) { filters.push(variables.filter); data = { issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } }; }
    else data = { issue: issueFor(variables.id) };
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ data }) };
  });
  return { client, filters };
}

test('unassigned ready issues are read only for the projects listed in settings.includeUnassigned', async () => {
  const settings = { projects: [project], includeUnassigned: { projectIds: ['p'] } };
  assert.equal(linearMapping(project, { projects: [project] }), mapping, 'off by default');
  const on = linearMapping(project, settings);
  assert.equal(on.includeUnassigned, true);
  assert.equal(assigneeAllowed({ assignee: null }, on), true);
  assert.equal(assigneeAllowed({ assignee: null }, mapping), false);
  assert.equal(assigneeAllowed({ assignee: { id: 'someone-else' } }, on), false);

  const { client, filters } = recordingClient(() => null);
  await client.issues(mapping);
  await client.issues(on);
  assert.deepEqual(filters[0].assignee, { id: { eq: 'me' } });
  assert.deepEqual(filters[1].or, [{ assignee: { id: { eq: 'me' } } }, { assignee: { null: true } }]);
  assert.equal(filters[1].assignee, undefined);

  filters.length = 0;
  await client.changes({ workspaceId: 'w', mappings: [on], targets: [], startedAt: Date.now() });
  assert.deepEqual(filters[0].or.map(f => f.assignee), [{ id: { eq: 'me' } }, { null: true }]);
});

test('an unassigned issue passes the start check only when included, and an issue assigned to someone else never does', async () => {
  const issues = { free: { id: 'free', project: { id: 'proj' }, assignee: null, state: { type: 'unstarted' } },
    other: { id: 'other', project: { id: 'proj' }, assignee: { id: 'someone-else' }, state: { type: 'unstarted' } } };
  const { client } = recordingClient(id => issues[id]);
  await assert.rejects(client.eligible(mapping, 'free'));
  await client.eligible({ ...mapping, includeUnassigned: true }, 'free');
  await assert.rejects(client.eligible({ ...mapping, includeUnassigned: true }, 'other'));
});

test('sync intake takes an unassigned Todo issue of an included project and never changes its assignee', async () => {
  const store = new MemoryStore(), state = initialState();
  state.paused = false;
  state.settings.projects = [project];
  state.settings.includeUnassigned = { projectIds: ['p'] };
  await store.save(state);
  const runtime = await new Runtime({ store, directory: os.tmpdir(), env: { TEST_TOKEN: 'synthetic' }, linearFactory: () => ({}) }).init();
  const issue = id => ({ id, identifier: `LON-${id}`, title: 't', url: 'https://linear.app/x', updatedAt: '2026-11-23T00:00:00.000Z', project: { id: 'proj' }, state: { id: 'todo' } });
  await runtime.intake({ projects: [project], issues: [{ ...issue('220'), assignee: null }, { ...issue('221'), assignee: { id: 'someone-else' } }, { ...issue('222'), assignee: { id: 'me' } }] });
  assert.deepEqual((await runtime.snapshot()).tasks.map(t => t.issue.identifier), ['LON-220', 'LON-222']);
  // without the switch only the receiver's own issue is taken
  const plain = new MemoryStore(), s2 = initialState();
  s2.settings.projects = [project]; await plain.save(s2);
  const other = await new Runtime({ store: plain, directory: os.tmpdir(), env: { TEST_TOKEN: 'synthetic' }, linearFactory: () => ({}) }).init();
  await other.intake({ projects: [project], issues: [{ ...issue('220'), assignee: null }, { ...issue('222'), assignee: { id: 'me' } }] });
  assert.deepEqual((await other.snapshot()).tasks.map(t => t.issue.identifier), ['LON-222']);
});

test('includeUnassigned is validated and can change while project tasks run', async () => {
  const settings = { ...initialState().settings, projects: [project] };
  assert.deepEqual(settingsSchema.parse({ ...settings, includeUnassigned: { projectIds: ['p'] } }).includeUnassigned, { projectIds: ['p'] });
  assert.throws(() => settingsSchema.parse({ ...settings, includeUnassigned: { projectIds: ['missing'] } }));
  const store = new MemoryStore(), state = initialState();
  state.settings.projects = [project];
  await store.save(state);
  const runtime = await new Runtime({ store, directory: os.tmpdir(), env: { TEST_TOKEN: 'synthetic' }, linearFactory: () => ({}) }).init();
  await runtime.submit({ projectId: 'p', prompt: 'Work', issue: { id: 'i', identifier: 'LON-1' }, source: 'w/i' });
  const snap = await runtime.snapshot();
  await runtime.command({ action: 'configure', revision: snap.revision, settings: { ...snap.settings, includeUnassigned: { projectIds: ['p'] } } });
  assert.deepEqual((await runtime.snapshot()).settings.includeUnassigned, { projectIds: ['p'] });
});
