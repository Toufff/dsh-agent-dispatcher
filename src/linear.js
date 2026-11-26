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
    selfPrefixGuard: entry.selfPrefixGuard ?? true,
    reportPrefix: entry.reportPrefix ?? (botMode ? '' : 'ZRSTUDIO：') };
}
/**
 * The account whose comments never answer a structured wait: the shared receiver (project.linear.assigneeId) in
 * legacy mode, the bot itself in bot mode (botId when known, else the configured botUserId). One rule for
 * validateLocalWait, the wait view and waitPolicy.
 */
export function replyExcludedId(project, settings, botId = null) {
  const mapping = linearMapping(project, settings);
  return mapping?.botMode ? botId || mapping.auth?.botUserId || null : project?.linear?.assigneeId;
}
/** Accounts a structured Linear wait may name as expected repliers (bot mode adds the owner accounts). */
export function waitReplyAuthors(project, settings, botId = null) {
  const mapping = linearMapping(project, settings), excluded = replyExcludedId(project, settings, botId);
  const ids = [...(project?.followup?.commentAuthorIds || []), ...(mapping?.botMode ? mapping.ownerUserIds || [] : [])];
  return [...new Set(ids)].filter(id => id && id !== excluded);
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
const focusShape = issue => issue ? { identifier: issue.identifier, title: issue.title || '', description: String(issue.description || '').slice(0, 20000),
  parent: issue.parent?.identifier || null, children: (issue.children?.nodes || []).map(c => c.identifier),
  comments: (issue.comments?.nodes || []).map(c => String(c.body || '').slice(0, 4000)) } : null;
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
  async query(query, variables = {}) {
    const result = await this.request(query, variables);
    if (result.errors?.length) throw new Error('Linear rejected the request; check scope and identifiers');
    return result.data;
  }
  /**
   * One HTTP request. Returns the raw GraphQL result ({data, errors}) so a batched (aliased) mutation can map each
   * alias's own success or failure; transport, rate-limit and authentication failures still throw for the whole
   * request. `onRequest` (set by the runtime) counts every HTTP request for linearUsage.
   */
  async request(query, variables = {}, retried = false) {
    const authorization = this.credential ? await this.credential.ready() : this.token;
    this.onRequest?.();
    const response = await this.fetcher('https://api.linear.app/graphql', {
      method: 'POST', headers: { Authorization: authorization, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(15000)
    });
    // An expired or revoked bot token: drop it and retry once with a fresh one.
    if (this.credential && response.status === 401) {
      this.credential.invalidate(authorization);
      if (!retried) return this.request(query, variables, true);
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
    // `status` lets callers tell a request Linear refused (4xx: retrying the same request cannot help) from a
    // transport or server failure (5xx, network): see isRejection.
    const httpError = () => Object.assign(new Error(`Linear HTTP ${response.status}`), { status: response.status });
    // Linear reports a rejected token as HTTP 400 with an AUTHENTICATION_ERROR body: read it for bot credentials.
    if (!response.ok && !(this.credential && response.status === 400)) throw httpError();
    const result = await response.json();
    if (!response.ok && !result?.errors?.some(e => e.extensions?.code === 'AUTHENTICATION_ERROR')) throw httpError();
    if (result.errors?.some(e => e.extensions?.code === 'RATELIMITED' || e.extensions?.code === 'RATE_LIMITED')) throw limited();
    if (this.credential && result.errors?.some(e => e.extensions?.code === 'AUTHENTICATION_ERROR')) {
      this.credential.invalidate(authorization);
      if (!retried) return this.request(query, variables, true);
      throw authFailure();
    }
    this.credential?.accepted(authorization);
    return result;
  }
  /**
   * Admission data of many issues in ONE request (organization check included): id, project, receiver, state.
   * Returns a Map id -> issue (missing ids are absent). Chunks of 250 ids; more ids mean more requests.
   */
  async issuesByIds(ids, mapping) {
    ids = [...new Set(ids.filter(Boolean))];
    const out = new Map();
    if (mapping) mapping = await this.resolve(mapping);
    for (let i = 0; i < ids.length; i += 250) {
      const chunk = ids.slice(i, i + 250);
      const data = await this.query(`query($filter:IssueFilter!) { organization { id }
        issues(filter:$filter, first:250, includeArchived:true) { nodes { id identifier title url updatedAt archivedAt project { id } assignee { id } delegate { id } state { id type } parent { id } ${relationFields} } } }`,
      { filter: { id: { in: chunk } } });
      if (mapping && data.organization?.id !== mapping.workspaceId) throw new Error('Linear token belongs to another workspace');
      for (const issue of data.issues?.nodes || []) out.set(issue.id, issue);
    }
    return out;
  }
  /**
   * Many writes as ONE aliased GraphQL mutation (Linear executes each alias independently).
   * ops: [{ alias, kind: 'comment' | 'issueCreate' | 'issueUpdate', input, id? }] (issueUpdate takes `id`).
   * Returns Map alias -> { ok, data } | { ok: false, error }. A transport / auth / rate-limit failure throws.
   */
  async batchWrite(ops) {
    if (!ops.length) return new Map();
    const decl = [], fields = [], variables = {};
    for (const op of ops) {
      if (!/^[a-z][a-z0-9_]{0,40}$/i.test(op.alias)) throw new Error('invalid alias');
      if (op.kind === 'comment') {
        decl.push(`$${op.alias}:CommentCreateInput!`); variables[op.alias] = op.input;
        fields.push(`${op.alias}: commentCreate(input:$${op.alias}) { success comment { id } }`);
      } else if (op.kind === 'issueCreate') {
        decl.push(`$${op.alias}:IssueCreateInput!`); variables[op.alias] = op.input;
        fields.push(`${op.alias}: issueCreate(input:$${op.alias}) { success issue { id identifier } }`);
      } else if (op.kind === 'issueUpdate') {
        decl.push(`$${op.alias}:IssueUpdateInput!`, `$${op.alias}_id:String!`); variables[op.alias] = op.input; variables[`${op.alias}_id`] = op.id;
        fields.push(`${op.alias}: issueUpdate(id:$${op.alias}_id, input:$${op.alias}) { success issue { id identifier state { type } } }`);
      } else throw new Error(`unknown write kind ${op.kind}`);
    }
    const result = await this.request(`mutation(${decl.join(', ')}) { ${fields.join(' ')} }`, variables);
    const failed = new Map();
    for (const e of result.errors || []) {
      const alias = e.path?.[0];
      if (alias) failed.set(alias, String(e.message || 'Linear rejected the write').slice(0, 200));
    }
    // An error without a path cannot be attributed (query validation, a bad variable value, complexity): when no
    // alias ran at all, the whole request was refused. It throws as a rejection so the caller can bisect the chunk
    // and isolate the alias that poisons it, instead of blaming every alias in it.
    const general = (result.errors || []).find(e => !e.path?.length);
    if (general && !ops.some(op => result.data?.[op.alias])) throw Object.assign(new Error(`Linear 拒绝整个请求：${String(general.message || '').slice(0, 200)}`), { status: 400, graphql: true });
    const out = new Map();
    for (const op of ops) {
      const value = result.data?.[op.alias];
      if (value?.success && !failed.has(op.alias)) out.set(op.alias, { ok: true, data: value });
      else out.set(op.alias, { ok: false, error: failed.get(op.alias) || (general ? String(general.message).slice(0, 200) : 'Linear write was not confirmed') });
    }
    return out;
  }
  /**
   * Before re-sending writes whose earlier attempt had an unknown outcome, and before moving issues whose state the
   * cache does not know freshly: ONE query for all of them. Returns { comments: Set(id), issues: Map(id -> issue) }.
   */
  /**
   * The same single read also returns the credential's workspace (organization id: writes never leave for another
   * workspace) and resolves issue refs (identifiers such as LON-123) the cache does not know: refs -> issue | null
   * (null = Linear has no such issue for this credential).
   */
  async writeCheck({ commentIds = [], issueIds = [], refs = [] }) {
    commentIds = [...new Set(commentIds)].slice(0, 250); issueIds = [...new Set(issueIds)].slice(0, 250); refs = [...new Set(refs)].slice(0, 40);
    const decl = [], parts = ['organization { id }'], variables = {};
    if (commentIds.length) { decl.push('$comments:CommentFilter!'); parts.push('comments(filter:$comments, first:250) { nodes { id } }'); variables.comments = { id: { in: commentIds } }; }
    if (issueIds.length) { decl.push('$issues:IssueFilter!'); parts.push('issues(filter:$issues, first:250, includeArchived:true) { nodes { id identifier state { id type } } }'); variables.issues = { id: { in: issueIds } }; }
    refs.forEach((ref, i) => { decl.push(`$r${i}:String!`); parts.push(`r${i}: issue(id:$r${i}) { id identifier state { id type } project { id } }`); variables[`r${i}`] = ref; });
    const result = await this.request(`query${decl.length ? `(${decl.join(', ')})` : ''} { ${parts.join(' ')} }`, variables);
    // A ref Linear cannot find fails only its own alias; any other error refuses the whole read.
    const refAlias = /^r\d+$/;
    if ((result.errors || []).some(e => !refAlias.test(String(e.path?.[0] ?? '')))) throw new Error('Linear rejected the request; check scope and identifiers');
    const data = result.data || {};
    return { organizationId: data.organization?.id || null, comments: new Set((data.comments?.nodes || []).map(c => c.id)),
      issues: new Map((data.issues?.nodes || []).map(i => [i.id, i])), refs: new Map(refs.map((ref, i) => [ref, data[`r${i}`] || null])) };
  }
  /** Focus contexts of many refs (ids or identifiers) in ONE aliased query. Map ref -> context | null. */
  async focusContexts(refs) {
    refs = [...new Set(refs.filter(Boolean))].slice(0, 40);
    const out = new Map();
    if (!refs.length) return out;
    const decl = refs.map((_, i) => `$r${i}:String!`).join(', ');
    const fields = refs.map((_, i) => `r${i}: issue(id:$r${i}) { identifier title description parent { identifier }
      children(first:50) { nodes { identifier } } comments(last:15) { nodes { body createdAt } } }`).join(' ');
    const result = await this.request(`query(${decl}) { ${fields} }`, Object.fromEntries(refs.map((r, i) => [`r${i}`, r])));
    refs.forEach((ref, i) => out.set(ref, focusShape(result.data?.[`r${i}`])));
    return out;
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
  async changes({ workspaceId, mappings, targets, issueSince, commentSince, startedAt, extraIds = [] }) {
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
    // Issues the runtime needs fresh (queued tasks' admission, pending state moves) ride on the same watched read:
    // one batched query per sync, never one request per task.
    const ids = [...new Set([...targets.flatMap(t => [t.parentId, t.issueId]), ...extraIds].filter(Boolean))];
    try { watched = ids.length ? await this.collection('issues', { id: { in: ids } }, `id identifier title url updatedAt project { id } assignee { id }${delegateField(mappings)} state { id type } parent { id } archivedAt ${relationFields}`, true) : [];
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
    // Same single paged query; the comment bodies it carries feed the runtime's cache (linear-view) at no extra request.
    const nodes = await this.collection('comments', { issue: { project: { id: { eq: mapping.projectId } } }, updatedAt: { gte: since } }, 'id body createdAt updatedAt user { id } issue { id identifier }');
    return Object.assign(new Set(nodes.map(c => c.issue?.id).filter(Boolean)), { comments: nodes });
  }
  /** Focus mode: what relatedness rules and the judge may read about one issue (read only, bounded). */
  async focusContext(ref) {
    const data = await this.query(`query($id:String!) { issue(id:$id) { identifier title description parent { identifier }
      children(first:50) { nodes { identifier } } comments(last:15) { nodes { body createdAt } } } }`, { id: ref });
    return focusShape(data?.issue);
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
