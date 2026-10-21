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
  async report(item) {
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
    if (['completed', 'canceled'].includes(currentState)) return;
    const result = await this.query('mutation($id:String!, $input:IssueUpdateInput!) { issueUpdate(id:$id,input:$input) { success } }',
      { id: item.issueId, input: { stateId: item.stateId } });
    if (!result.issueUpdate.success) throw new Error('Linear state update was not confirmed');
  }
}
