import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LinearClient } from '../src/linear.js';

test('catalog paginates authorized metadata without reading issues or writing', async () => {
  const requests = [];
  const client = new LinearClient('synthetic', async (url, request) => {
    const { query, variables } = JSON.parse(request.body); requests.push({ query, variables });
    let data;
    if (query.includes('viewer')) data = { viewer: { id: 'me', name: 'Me' }, organization: { id: 'w', name: 'Workspace' } };
    else {
      const key = ['projects', 'users', 'workflowStates'].find(k => query.includes(`${k}(`));
      data = { [key]: { nodes: [{ id: `${key}-${variables.after || 'first'}` }], pageInfo: {
        hasNextPage: key === 'projects' && !variables.after, endCursor: 'second'
      } } };
    }
    return { ok: true, json: async () => ({ data }) };
  });
  const catalog = await client.catalog();
  assert.equal(catalog.projects.length, 2); assert.equal(catalog.viewer.name, 'Me');
  assert.equal(catalog.users.length, 1); assert.equal(catalog.workflowStates.length, 1);
  assert.ok(requests.every(r => !/mutation|issues\(/.test(r.query)));
  assert.ok(!JSON.stringify(catalog).includes('synthetic'));
});

test('catalog rejects nonadvancing pagination instead of looping forever', async () => {
  const client = new LinearClient('synthetic', async () => ({ ok: true, json: async () => ({ data: {
    viewer: { id: 'me' }, organization: { id: 'w' },
    projects: { nodes: [], pageInfo: { hasNextPage: true, endCursor: null } }
  } }) }));
  await assert.rejects(client.catalog(), /pagination/);
});

test('display context reads disabled/completed task identities without changing assignment or trusting unrelated users', async () => {
  let targetParent = 'parent', workspace = 'w'; const queries = [];
  const client = new LinearClient('synthetic', async (url, request) => {
    const { query } = JSON.parse(request.body); queries.push(query);
    const data = query.includes('organization') ? { organization: { id: workspace } } : {
      source: { id: 'parent', project: { id: 'p' }, assignee: { id: 'owner', name: 'Owner' } },
      target: { id: 'child', project: { id: 'p' }, parent: { id: targetParent }, assignee: { id: 'peer', name: 'Peer Name' } },
      users: { nodes: [{ id: 'peer', name: 'Peer Name' }, { id: 'other', name: 'Untrusted' }] }
    };
    return { ok: true, json: async () => ({ data }) };
  });
  const mapping = { workspaceId: 'w', projectId: 'p', enabled: false };
  const context = await client.issueContext(mapping, 'parent', 'child', ['peer']);
  assert.equal(context.target.assignee.name, 'Peer Name'); assert.equal(context.replyUsers.length, 1);
  assert.ok(queries.every(q => !q.includes('mutation')));
  targetParent = 'unrelated'; await assert.rejects(client.issueContext(mapping, 'parent', 'child', ['peer']), /direct child/);
  workspace = 'other'; await assert.rejects(client.issueContext(mapping, 'parent', 'child', ['peer']), /another workspace/);
});

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

test('unfinished notification without a configured state never updates issue state', async () => {
  const queries = [];
  const client = new LinearClient('synthetic', async (url, request) => {
    const data = JSON.parse(request.body); queries.push(data.query);
    return { ok: true, json: async () => ({ data: { issue: { state: { type: 'started' }, comments: {
      nodes: [{ id: 'comment' }], pageInfo: { hasNextPage: false, endCursor: null }
    } } } }) };
  });
  await client.report({ id: 'comment', issueId: 'issue', body: 'Blocked' });
  assert.equal(queries.length, 1);
});

test('activity validates parent ownership and child relationship and paginates completed child replies',async()=>{
 const mapping={workspaceId:'w',projectId:'p',assigneeId:'owner'};let parentState='started',assignee='owner',childParent='parent',pages=0;
 const client=new LinearClient('synthetic',async(url,request)=>{
  const {query,variables}=JSON.parse(request.body);let data;
  if(query.includes('organization'))data={organization:{id:'w'}};
  else if(!query.includes('comments'))data={issue:{id:'parent',project:{id:'p'},assignee:{id:assignee},state:{type:parentState}}};
  else {pages++;data={issue:{id:'child',identifier:'EX-2',project:{id:'p'},parent:{id:childParent},state:{type:'completed'},comments:{nodes:[{id: variables.after?'b':'a',user:{id:'peer'},body:'receipt'}],pageInfo:{hasNextPage:!variables.after,endCursor:'cursor'}}}};}
  return {ok:true,json:async()=>({data})};
 });
 assert.equal((await client.activity(mapping,'child','parent')).comments.length,2);assert.equal(pages,2);
 assignee='other';await assert.rejects(client.activity(mapping,'child','parent'),/reassigned/);
 assignee='owner';parentState='completed';await assert.rejects(client.activity(mapping,'child','parent'),/closed/);
 parentState='started';childParent='unrelated';await assert.rejects(client.activity(mapping,'child','parent'),error=>error.code==='INVALID_WAIT_TARGET');
});
