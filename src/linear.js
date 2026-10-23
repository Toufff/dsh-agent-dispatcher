/** Fixed official endpoint: issue content cannot redirect credentials. */
export class LinearClient {
  constructor(token, fetcher = fetch) { this.token = token; this.fetcher = fetcher; }
  async query(query, variables = {}) {
    const response = await this.fetcher('https://api.linear.app/graphql', {
      method: 'POST', headers: { Authorization: this.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(15000)
    });
    if (!response.ok) throw new Error(`Linear HTTP ${response.status}`);
    const result = await response.json();
    if (result.errors?.length) throw new Error('Linear rejected the request; check scope and identifiers');
    return result.data;
  }
  async catalog() {
    const identity = await this.query('query { viewer { id name } organization { id name } }');
    const result = { viewer: identity.viewer, organization: identity.organization };
    // Bounded, paginated metadata only. Never read issue content or mutate Linear.
    for (const [key, fields] of Object.entries({
      projects: 'id name',
      users: 'id name',
      workflowStates: 'id name type team { id name }'
    })) {
      const nodes = []; let after = null;
      do {
        const data = await this.query(`query($after:String) { ${key}(first:100, after:$after) {
          nodes { ${fields} } pageInfo { hasNextPage endCursor }
        } }`, { after });
        const page = data[key]; nodes.push(...page.nodes);
        if (nodes.length > 5000) throw new Error('Linear catalog too large');
        const next = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
        if (page.pageInfo.hasNextPage && (!next || next === after)) throw new Error('Linear catalog pagination failed');
        after = next;
      } while (after);
      result[key] = nodes;
    }
    return result;
  }
  async issues(mapping) {
    const identity = await this.query('query { organization { id } }');
    if (identity.organization.id !== mapping.workspaceId) throw new Error('Linear token belongs to another workspace');
    let cursor = null, issues = [];
    do {
      const data = await this.query(`query($filter:IssueFilter!, $after:String) {
        issues(filter:$filter, first:100, after:$after) {
          nodes { id identifier title description url updatedAt }
          pageInfo { hasNextPage endCursor }
        }
      }`, { filter: { project: { id: { eq: mapping.projectId } }, assignee: { id: { eq: mapping.assigneeId } },
        state: { id: { eq: mapping.readyStateId } }, updatedAt: { gte: mapping.since } }, after: cursor });
      issues.push(...data.issues.nodes);
      cursor = data.issues.pageInfo.hasNextPage ? data.issues.pageInfo.endCursor : null;
      if (issues.length > 5000) throw new Error('Intake too broad; narrow the activation date');
    } while (cursor);
    return issues;
  }
  async eligible(mapping, parentId) {
    const identity = await this.query('query { organization { id } }');
    if (identity.organization.id !== mapping.workspaceId) throw new Error('Linear token belongs to another workspace');
    const parent = (await this.query('query($id:String!) { issue(id:$id) { id project { id } assignee { id } state { type } } }', { id: parentId })).issue;
    if (!parent || parent.project?.id !== mapping.projectId || parent.assignee?.id !== mapping.assigneeId || ['completed', 'canceled'].includes(parent.state?.type))
      throw new Error('Parent issue is closed, reassigned or outside the mapped project; local continuation remains stopped');
    return parent;
  }
  async issueContext(mapping, parentId, targetId, authorIds = []) {
    const identity = await this.query('query { organization { id } }');
    if (identity.organization.id !== mapping.workspaceId) throw new Error('Linear token belongs to another workspace');
    const fields = 'id identifier title url project { id } parent { id } assignee { id name displayName }';
    const data = await this.query(`query($parent:String!, $target:String!, $authors:UserFilter!) {
      source:issue(id:$parent) { ${fields} }
      target:issue(id:$target) { ${fields} }
      users(filter:$authors, first:50) { nodes { id name displayName } }
    }`, { parent: parentId, target: targetId, authors: { id: { in: [...new Set(authorIds)].slice(0, 30) } } });
    if (!data.source || !data.target || data.source.project?.id !== mapping.projectId ||
        data.target.project?.id !== mapping.projectId || (data.target.id !== parentId && data.target.parent?.id !== parentId))
      throw new Error('Related issue is not the mapped issue or its direct child');
    // Display-only data. It never changes assignees, admission rules, trusted IDs or wait cursors.
    return { source: data.source, target: data.target, replyUsers: data.users.nodes.filter(u => authorIds.includes(u.id)), checkedAt: new Date().toISOString() };
  }
  async activity(mapping, issueId, parentId) {
    const parent = await this.eligible(mapping, parentId);
    let cursor = null, comments = [], issue;
    do {
      const data = await this.query(`query($id:String!, $after:String) {
        issue(id:$id) { id identifier project { id } parent { id } assignee { id } state { type }
          comments(first:100, after:$after) { nodes { id body createdAt updatedAt user { id } }
            pageInfo { hasNextPage endCursor } } }
      }`, { id: issueId, after: cursor });
      issue = data.issue;
      if (!issue || issue.project?.id !== mapping.projectId || (issue.id !== parentId && issue.parent?.id !== parentId))
        throw new Error('Follow-up must target the mapped issue or its direct child in the same project');
      comments.push(...issue.comments.nodes);
      if (comments.length > 5000) throw new Error('Follow-up comment history is too broad');
      cursor = issue.comments.pageInfo.hasNextPage ? issue.comments.pageInfo.endCursor : null;
    } while (cursor);
    return { ...issue, comments, parentState: parent.state };
  }
  async report(item, mapping) {
    if (mapping) {
      const identity = await this.query('query { organization { id } }');
      if (identity.organization.id !== mapping.workspaceId) throw new Error('Linear token belongs to another workspace');
    }
    // Client-chosen comment identity makes timeout retries idempotent.
    let cursor = null, found = false, currentState;
    do {
      const existing = await this.query('query($id:String!, $after:String) { issue(id:$id) { state { type } comments(first:100, after:$after) { nodes { id } pageInfo { hasNextPage endCursor } } } }', { id: item.issueId, after: cursor });
      currentState = existing.issue.state.type;
      found = existing.issue.comments.nodes.some(c => c.id === item.id);
      cursor = existing.issue.comments.pageInfo.hasNextPage ? existing.issue.comments.pageInfo.endCursor : null;
    } while (!found && cursor);
    if (!found) {
      const result = await this.query('mutation($input:CommentCreateInput!) { commentCreate(input:$input) { success } }',
        { input: { id: item.id, issueId: item.issueId, body: item.body } });
      if (!result.commentCreate.success) throw new Error('Linear comment was not confirmed');
    }
    if (!item.stateId || ['completed', 'canceled'].includes(currentState)) return;
    const result = await this.query('mutation($id:String!, $input:IssueUpdateInput!) { issueUpdate(id:$id,input:$input) { success } }',
      { id: item.issueId, input: { stateId: item.stateId } });
    if (!result.issueUpdate.success) throw new Error('Linear state update was not confirmed');
  }
}
