import { credentialKey } from './linear-auth.js';

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

/**
 * The Linear mapping of a project as the client uses it. settings.includeUnassigned.projectIds lists projects
 * whose unassigned ready issues are taken as well (read only: the dispatcher never assigns them). It lives at the
 * settings top level so it can change without stopping the project's tasks or invalidating their waits.
 */
export function linearMapping(project, settings) {
  if (!project?.linear) return project?.linear;
  let mapping = settings?.includeUnassigned?.projectIds?.includes(project.id) ? { ...project.linear, includeUnassigned: true } : project.linear;
  const binding = linearBinding(project, settings);
  if (binding) mapping = { ...mapping, ...binding };
  return mapping;
}
/**
 * The bot / credential switch of a project (settings.linear, top level like includeUnassigned, so switching and
 * rolling back never touch project.linear: running tasks and their waits keep their identity). Returns the fields
 * merged into the mapping, or null for a project that is not listed (legacy behaviour, unchanged).
 */
export function linearBinding(project, settings) {
  const block = settings?.linear, entry = block?.projects?.find(p => p.projectId === project?.id);
  if (!entry || !project?.linear) return null;
  const credentials = block.credentials || [];
  const auth = entry.credential ? credentials.find(c => c.id === entry.credential)
    : credentials.find(c => c.default && (!c.workspaceId || c.workspaceId === project.linear.workspaceId));
  const intakeBy = entry.intake?.by || 'assignee';
  const botMode = (entry.commentTrust || (intakeBy === 'delegate' ? 'bot' : 'legacy')) === 'bot';
  return { auth: auth ? { workspaceId: project.linear.workspaceId, ...auth } : null, intakeBy, botMode,
    ownerUserIds: entry.ownerUserIds || [project.linear.assigneeId],
    reportPrefix: entry.reportPrefix ?? (botMode ? '' : 'ZRSTUDIO：') };
}
/** Sync/sweep grouping key of a mapping: legacy keys stay exactly as before. */
export function syncKey(mapping) {
  const base = [mapping.workspaceId, mapping.tokenEnv];
  return JSON.stringify(mapping.auth || mapping.intakeBy === 'delegate' ? [...base, credentialKey(mapping.auth) || 'none', mapping.intakeBy || 'assignee'] : base);
}
/**
 * An issue belongs to the mapping's receiver: assigned to it (or unassigned when the mapping includes those);
 * in delegate mode delegated to the bot. A delegate mapping without a resolved bot id admits nothing (fail closed).
 */
export const receiverAllowed = (issue, mapping) => mapping.intakeBy === 'delegate'
  ? Boolean(mapping.delegateId) && issue?.delegate?.id === mapping.delegateId
  : issue?.assignee?.id === mapping.assigneeId || Boolean(mapping.includeUnassigned) && !issue?.assignee?.id;
export const assigneeAllowed = receiverAllowed;
const assigneeFilters = mapping => [{ id: { eq: mapping.assigneeId } }, ...(mapping.includeUnassigned ? [{ null: true }] : [])];
/** Filter clauses selecting the mapping's receiver. */
const receiverClauses = mapping => mapping.intakeBy === 'delegate'
  ? [{ delegate: { id: { eq: mapping.delegateId } } }]
  : assigneeFilters(mapping).map(assignee => ({ assignee }));
const delegateField = mappings => mappings.some(m => m?.intakeBy === 'delegate') ? ' delegate { id }' : '';
const authFailure = () => Object.assign(new Error('Linear 认证失败'), { code: 'LINEAR_UNAUTHENTICATED' });

/**
 * Fixed official endpoint: issue content cannot redirect credentials. `token` is a personal API key (legacy) or a
 * credential object (src/linear-auth.js) that supplies the header, refreshes the bot token and checks identity.
 */
export class LinearClient {
  constructor(token, fetcher = fetch) {
    if (token && typeof token === 'object') this.credential = token; else this.token = token;
    this.fetcher = fetcher;
  }
  /** Delegate mappings get the bot's own id (viewer of this credential) before any filter is built. */
  async resolve(mapping) {
    if (mapping?.intakeBy !== 'delegate' || mapping.delegateId) return mapping;
    if (!this.credential) throw Object.assign(new Error('委派接单需要机器人凭据'), { code: 'LINEAR_AUTH' });
    return { ...mapping, delegateId: (await this.credential.identity()).id };
  }
  async query(query, variables = {}, retried = false) {
    const authorization = this.credential ? await this.credential.ready() : this.token;
    const response = await this.fetcher('https://api.linear.app/graphql', {
      method: 'POST', headers: { Authorization: authorization, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(15000)
    });
    // An expired or revoked bot token: drop it and retry once with a fresh one.
    if (this.credential && response.status === 401) {
      this.credential.invalidate(authorization);
      if (!retried) return this.query(query, variables, true);
      throw authFailure();
    }
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
    // Linear reports a rejected token as HTTP 400 with an AUTHENTICATION_ERROR body: read it for bot credentials.
    if (!response.ok && !(this.credential && response.status === 400)) throw new Error(`Linear HTTP ${response.status}`);
    const result = await response.json();
    if (!response.ok && !result?.errors?.some(e => e.extensions?.code === 'AUTHENTICATION_ERROR')) throw new Error(`Linear HTTP ${response.status}`);
    if (result.errors?.some(e => e.extensions?.code === 'RATELIMITED' || e.extensions?.code === 'RATE_LIMITED')) throw limited();
    if (this.credential && result.errors?.some(e => e.extensions?.code === 'AUTHENTICATION_ERROR')) {
      this.credential.invalidate(authorization);
      if (!retried) return this.query(query, variables, true);
      throw authFailure();
    }
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
    mappings = await Promise.all(mappings.map(m => this.resolve(m)));
    const fields = `id identifier title description url updatedAt project { id } assignee { id }${delegateField(mappings)} state { id type } parent { id }`;
    let issues = [], watched = [], comments = [], issueError, activityError;
    try { issues = mappings.length ? await this.collection('issues', { or: mappings.flatMap(m => receiverClauses(m).map(receiver => ({
      project: { id: { eq: m.projectId } }, ...receiver, state: { id: { eq: m.readyStateId } },
      updatedAt: { gte: issueSince && issueSince > m.since ? issueSince : m.since, lte: until }
    }))) }, fields) : []; } catch (error) { if (error.code === 'RATE_LIMITED') throw error; issueError = error; }
    const ids = [...new Set(targets.flatMap(t => [t.parentId, t.issueId]))];
    try { watched = ids.length ? await this.collection('issues', { id: { in: ids } }, `id identifier project { id } assignee { id }${delegateField(mappings)} state { id type } parent { id } archivedAt ${relationFields}`, true) : [];
    comments = targets.length ? await this.collection('comments', {
      issue: { id: { in: [...new Set(targets.map(t => t.issueId))] } }, updatedAt: { gte: commentSince, lte: until }
    }, 'id body createdAt updatedAt user { id } issue { id }') : [];
    } catch (error) { if (error.code === 'RATE_LIMITED') throw error; activityError = error; }
    return { issues, watched, comments, until, issueError, activityError, mappings };
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
    mapping = await this.resolve(mapping);
    let cursor = null, issues = [];
    do {
      const data = await this.query(`query($filter:IssueFilter!, $after:String) {
        issues(filter:$filter, first:100, after:$after) {
          nodes { id identifier title description url updatedAt }
          pageInfo { hasNextPage endCursor }
        }
      }`, { filter: { project: { id: { eq: mapping.projectId } }, ...(mapping.intakeBy === 'delegate' ? receiverClauses(mapping)[0] : mapping.includeUnassigned ? { or: assigneeFilters(mapping).map(assignee => ({ assignee })) } : { assignee: { id: { eq: mapping.assigneeId } } }),
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
    mapping = await this.resolve(mapping);
    const parent = (await this.query(`query($id:String!) { issue(id:$id) { id project { id } assignee { id }${delegateField([mapping])} state { type } ${relationFields} } }`, { id: parentId })).issue;
    if (!parent || parent.project?.id !== mapping.projectId || !assigneeAllowed(parent, mapping) || ['completed', 'canceled'].includes(parent.state?.type))
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
  /** Issue ids in the mapped project with a comment created or edited since `since`: one paged query for all issues. */
  async commentedIssues(mapping, since) {
    const nodes = await this.collection('comments', { issue: { project: { id: { eq: mapping.projectId } } }, updatedAt: { gte: since } }, 'id issue { id }');
    return new Set(nodes.map(c => c.issue?.id).filter(Boolean));
  }
  /** Focus mode: what relatedness rules and the judge may read about one issue (read only, bounded). */
  async focusContext(ref) {
    const data = await this.query(`query($id:String!) { issue(id:$id) { identifier title description parent { identifier }
      children(first:50) { nodes { identifier } } comments(last:15) { nodes { body createdAt } } } }`, { id: ref });
    const issue = data?.issue;
    if (!issue) return null;
    return { identifier: issue.identifier, title: issue.title || '', description: String(issue.description || '').slice(0, 20000),
      parent: issue.parent?.identifier || null, children: (issue.children?.nodes || []).map(c => c.identifier),
      comments: (issue.comments?.nodes || []).map(c => String(c.body || '').slice(0, 4000)) };
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
    // An empty body is a state-only report: no comment is created.
    let cursor = null, found = !item.body, currentState;
    if (!item.body) currentState = (await this.query('query($id:String!) { issue(id:$id) { state { type } } }', { id: item.issueId })).issue.state.type;
    else do {
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
