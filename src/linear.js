export class WaitTargetError extends Error {
  constructor() { super('等待目标必须是当前工单、同项目直接子单或 Linear 明确关联的工单；请修正恢复条件，重试不会解决此问题。'); this.code = 'INVALID_WAIT_TARGET'; }
}

// Only server-confirmed, direct relations grant a subscription, never an agent's prose.
export const relationFields = 'relations(first:100) { nodes { type relatedIssue { id } } pageInfo { hasNextPage } } inverseRelations(first:100) { nodes { type issue { id } } pageInfo { hasNextPage } }';
export function validWaitTarget(source, target, projectId) {
  if (!source || !target || source.project?.id !== projectId || target.project?.id !== projectId || target.archivedAt) return false;
  if (source.id === target.id || target.parent?.id === source.id) return true;
  // A truncated relation list cannot establish that we saw the complete routing contract.
  if (source.relations?.pageInfo?.hasNextPage || source.inverseRelations?.pageInfo?.hasNextPage) return false;
  return [...(source.relations?.nodes || []), ...(source.inverseRelations?.nodes || [])]
    .some(r => ['related', 'blocks'].includes(r.type) && (r.relatedIssue?.id || r.issue?.id) === target.id);
}

/** Fixed official endpoint: issue content cannot redirect credentials. */
export class LinearClient {
  constructor(token, fetcher = fetch) { this.token = token; this.fetcher = fetcher; }
  async query(query, variables = {}) {
    const response = await this.fetcher('https://api.linear.app/graphql', {
      method: 'POST', headers: { Authorization: this.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(15000)
    });
    const serverTime = Date.parse(response.headers?.get('date'));
    if (Number.isFinite(serverTime)) this.serverTime = serverTime;
    const limited = () => {
      const retry = response.headers?.get('retry-after');
      const reset = Number(response.headers?.get('x-ratelimit-requests-reset'));
      const delay = retry && Number.isFinite(Number(retry)) ? Number(retry) * 1000 : Date.parse(retry) - Date.now();
      const error = new Error('Linear 请求限流，已推迟同步'); error.code = 'RATE_LIMITED';
      error.retryAfterMs = Math.max(60000, Number.isFinite(delay) ? delay : 0, reset > Date.now() ? reset - Date.now() : 0);
      return error;
    };
    if (response.status === 429) throw limited();
    if (!response.ok) throw new Error(`Linear HTTP ${response.status}`);
    const result = await response.json();
    if (result.errors?.some(e => e.extensions?.code === 'RATELIMITED' || e.extensions?.code === 'RATE_LIMITED')) throw limited();
    if (result.errors?.length) throw new Error('Linear rejected the request; check scope and identifiers');
    return result.data;
  }
  async collection(kind, filter, fields, includeArchived = false) {
    const nodes = []; let after = null;
    do {
      const data = await this.query(`query($filter:${kind === 'comments' ? 'CommentFilter' : 'IssueFilter'}!, $after:String) {
        ${kind}(filter:$filter, first:100, after:$after, orderBy:updatedAt, includeArchived:${includeArchived}) {
          nodes { ${fields} } pageInfo { hasNextPage endCursor }
        }
      }`, { filter, after });
      const page = data[kind]; nodes.push(...page.nodes);
      if (nodes.length > 5000) throw new Error('Linear 同步范围过大，请缩小项目或等待范围');
      const next = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
      if (page.pageInfo.hasNextPage && (!next || next === after)) throw new Error('Linear pagination did not advance');
      after = next;
    } while (after);
    return nodes;
  }
  async changes({ workspaceId, mappings, targets, issueSince, commentSince, startedAt }) {
    const identity = await this.query('query { organization { id } }');
    if (identity.organization.id !== workspaceId) throw new Error('Linear token belongs to another workspace');
    // Use the earlier clock and overlap on the next read; never advance to completion time.
    const until = new Date(Math.min(startedAt, this.serverTime || startedAt)).toISOString();
    const fields = 'id identifier title description url updatedAt project { id } assignee { id } state { id type } parent { id }';
    let issues = [], watched = [], comments = [], issueError, activityError;
    try { issues = mappings.length ? await this.collection('issues', { or: mappings.map(m => ({
      project: { id: { eq: m.projectId } }, assignee: { id: { eq: m.assigneeId } }, state: { id: { eq: m.readyStateId } },
      updatedAt: { gte: issueSince && issueSince > m.since ? issueSince : m.since, lte: until }
    })) }, fields) : []; } catch (error) { if (error.code === 'RATE_LIMITED') throw error; issueError = error; }
    const ids = [...new Set(targets.flatMap(t => [t.parentId, t.issueId]))];
    try { watched = ids.length ? await this.collection('issues', { id: { in: ids } }, `id identifier project { id } assignee { id } state { id type } parent { id } archivedAt ${relationFields}`, true) : [];
    comments = targets.length ? await this.collection('comments', {
      issue: { id: { in: [...new Set(targets.map(t => t.issueId))] } }, updatedAt: { gte: commentSince, lte: until }
    }, 'id body createdAt updatedAt user { id } issue { id }') : [];
    } catch (error) { if (error.code === 'RATE_LIMITED') throw error; activityError = error; }
    return { issues, watched, comments, until, issueError, activityError };
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
    const parent = (await this.query(`query($id:String!) { issue(id:$id) { id project { id } assignee { id } state { type } ${relationFields} } }`, { id: parentId })).issue;
    if (!parent || parent.project?.id !== mapping.projectId || parent.assignee?.id !== mapping.assigneeId || ['completed', 'canceled'].includes(parent.state?.type))
      throw new Error('Parent issue is closed, reassigned or outside the mapped project; local continuation remains stopped');
    return parent;
  }
  async issueContext(mapping, parentId, targetId, authorIds = []) {
    const identity = await this.query('query { organization { id } }');
    if (identity.organization.id !== mapping.workspaceId) throw new Error('Linear token belongs to another workspace');
    const fields = 'id identifier title url project { id } parent { id } assignee { id name displayName }';
    const data = await this.query(`query($parent:String!, $target:String!, $authors:UserFilter!) {
      source:issue(id:$parent) { ${fields} ${relationFields} }
      target:issue(id:$target) { ${fields} }
      users(filter:$authors, first:50) { nodes { id name displayName } }
    }`, { parent: parentId, target: targetId, authors: { id: { in: [...new Set(authorIds)].slice(0, 30) } } });
    if (!validWaitTarget(data.source, data.target, mapping.projectId)) throw new WaitTargetError();
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
      if (!validWaitTarget(parent, issue, mapping.projectId))
        throw new WaitTargetError();
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
