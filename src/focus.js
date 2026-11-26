/**
 * Focus mode: the owner names the issues they actively want worked on; everything else stops being started
 * automatically, without being lost. Tasks in focus, or judged related to it, keep full automation (automatic
 * continuation, comment / time / data wakes, session rotation, fresh-session rescue): those paths all end in a
 * queued round, and the gate is the start (`automaticBlock(task, state, 'start')`). A wake of a task already judged
 * unrelated is not taken (its event stays for later), so it neither shows as resumed nor spends wake budget.
 *
 * Relatedness: deterministic rules first (pure, `relatedByRules`), then a model judge for the rest (runtime,
 * asynchronous, single-flight; see src/focus-judge.js). A judge error, timeout or 'uncertain' never starts the task:
 * it waits in `state.focus.pending` for focus-approve / focus-reject.
 *
 * Unrelated tasks are held, not lost: a queued round of an unrelated task gets `task.hold = { by: 'focus', ... }`
 * (the foundation hold, src/hold.js). A running unrelated round finishes its turn; its next round is queued and held.
 * Focus changes release focus holds only; a user hold (stop) stays until an explicit owner action.
 *
 * State (`state.focus`, persisted): { enabled, issues, intent, revision, since, decisions, pending, rejected }.
 * Decisions and pending entries are valid for one focus revision; every focus change bumps it (an add of issues
 * carries the 'related' decisions over, see bump).
 */
export const FOCUS_HELD = 'FOCUS_HELD';
export const FOCUS_PENDING = 'FOCUS_PENDING';
export const ISSUE_ID = /^[A-Z][A-Z0-9]{0,15}-\d{1,7}$/;
const ID_IN_TEXT = /(?<![A-Za-z0-9_-])([A-Z][A-Z0-9]{0,15}-\d{1,7})(?![A-Za-z0-9_])/g;
// Split / handover markers: the identifier after the marker is the other side of a handover.
const HANDOVER = /(移交|接管|转交|交接|拆单|拆出|拆到|split_issue|split[- ]?to|hand(?:ed)?[- ]?over(?:\s+to)?)[^A-Za-z\n]{0,24}?([A-Z][A-Z0-9]{0,15}-\d{1,7})(?![A-Za-z0-9_])/gi;
const LOCAL_TEXT = 20000;
const MAX_ISSUES = 200;

export function normalizeIssues(list) {
  const out = [];
  for (const raw of Array.isArray(list) ? list : [list]) {
    const id = String(raw ?? '').trim().toUpperCase();
    if (!id) continue;
    if (!ISSUE_ID.test(id)) throw new Error(`Not an issue identifier: ${String(raw).slice(0, 40)}`);
    if (!out.includes(id)) out.push(id);
  }
  if (out.length > MAX_ISSUES) throw new Error(`At most ${MAX_ISSUES} focus issues`);
  return out;
}

/** Identifiers mentioned in a text (word-bounded: LON-3 is not found in LON-35). */
export function mentionedIssues(text) {
  return new Set([...String(text || '').matchAll(ID_IN_TEXT)].map(m => m[1].toUpperCase()));
}
/** Identifiers a text hands work over to / takes it over from ("移交 LON-45", "接管 LON-35", "split_issue": "LON-48"). */
export function handoverIssues(text) {
  return new Set([...String(text || '').matchAll(HANDOVER)].map(m => m[2].toUpperCase()));
}

const joinText = c => [c?.title, c?.description, ...(c?.comments || [])].filter(Boolean).join('\n');

/**
 * Deterministic relatedness (no model). focus: { issues, contexts? } where contexts maps a focus identifier to
 * { parent, children, title, description, comments } when known. candidate: { identifier, title, description,
 * comments: [text], parent, children: [identifier], chain: [identifier] }. Returns
 * { verdict: 'related', rule, via, reason } or null (rules cannot tell; ask the judge).
 */
export function relatedByRules({ focus, candidate }) {
  const set = new Set(focus?.issues || []);
  const id = candidate?.identifier;
  const hit = (rule, via, reason) => ({ verdict: 'related', rule, via, reason });
  if (id && set.has(id)) return hit('focus-list', id, `${id} 在聚焦清单中`);
  for (const other of candidate?.chain || []) if (set.has(other)) return hit('chain', other, `续办链上有聚焦单 ${other}`);
  if (candidate?.parent && set.has(candidate.parent)) return hit('parent', candidate.parent, `父单 ${candidate.parent} 在聚焦清单中`);
  for (const child of candidate?.children || []) if (set.has(child)) return hit('child', child, `子单 ${child} 在聚焦清单中`);
  const contexts = focus?.contexts || {};
  if (id) for (const [f, ctx] of Object.entries(contexts)) {
    if (!set.has(f) || !ctx) continue;
    if (ctx.parent === id) return hit('child', f, `聚焦单 ${f} 是它的子单`);
    if ((ctx.children || []).includes(id)) return hit('parent', f, `聚焦单 ${f} 是它的父单`);
  }
  const text = joinText(candidate);
  for (const other of handoverIssues(text)) if (set.has(other)) return hit('handover', other, `单子写了与聚焦单 ${other} 的移交/接管`);
  if (id) for (const [f, ctx] of Object.entries(contexts)) {
    if (set.has(f) && handoverIssues(joinText(ctx)).has(id)) return hit('handover', f, `聚焦单 ${f} 写了移交/拆单到 ${id}`);
  }
  // A bare mention releases only from the title. Descriptions, comments (including the dispatcher's own result
  // comments) and the dispatcher's prompts (basePrompt / prompt) routinely cite LON-28, LON-221 ... as references;
  // there a mention is only a hint for the judge (mentionHints), never a release.
  for (const other of mentionedIssues(candidate?.title)) if (set.has(other) && other !== id) return hit('mention', other, `标题提到聚焦单 ${other}`);
  return null;
}

/** Focus identifiers mentioned anywhere in the candidate's text (a hint for the judge, not a rule). */
export function mentionHints({ focus, candidate }) {
  const set = new Set(focus?.issues || []);
  return [...mentionedIssues(joinText(candidate))].filter(i => set.has(i) && i !== candidate?.identifier);
}

export const focusOn = state => Boolean(state?.focus?.enabled);
export const userHeld = task => Boolean(task?.hold) && task.hold.by !== 'focus';
export const focusHeld = task => task?.hold?.by === 'focus';

/** Identifiers on the task's continuation chain (predecessors and successors in the hot state). */
export function chainIssues(task, state) {
  const out = new Set(), seen = new Set();
  const byId = id => state.tasks.find(t => t.id === id);
  for (let t = task; t && !seen.has(t.id); t = t.continuationOf && byId(t.continuationOf)) { seen.add(t.id); if (t.issue?.identifier) out.add(t.issue.identifier.toUpperCase()); }
  for (let t = task; t?.supersededBy && !seen.has(t.supersededBy); ) {
    t = byId(t.supersededBy); if (!t) break;
    seen.add(t.id); if (t.issue?.identifier) out.add(t.issue.identifier.toUpperCase());
  }
  const root = task.rootTaskId || task.id;
  for (const t of state.tasks) if ((t.rootTaskId === root || t.id === root) && t.issue?.identifier) out.add(t.issue.identifier.toUpperCase());
  return [...out];
}

/** What the local state alone says about a task (no Linear read, no model). */
export function localCandidate(task, state) {
  const identifier = task.issue?.identifier?.toUpperCase() || null;
  return { identifier, title: task.title || '', description: String(task.basePrompt || task.prompt || '').slice(0, LOCAL_TEXT),
    comments: (task.pendingComments || []).map(c => String(c.body || '').slice(0, 2000)),
    parent: task.issue?.parent || null, children: [], chain: chainIssues(task, state).filter(i => i !== identifier) };
}

/**
 * The focus verdict for a task now: { verdict: 'related' | 'unrelated' | 'pending' | 'unknown', by, rule?, reason }.
 * 'unknown' means no rule matched and nothing was judged for this revision yet (the runtime asks the judge).
 */
export function focusDecision(task, state) {
  const focus = state?.focus;
  if (!focus?.enabled) return { verdict: 'related', by: 'off', reason: '聚焦模式未开启' };
  // A turn that died with the host is the current turn, not a new one: it is allowed to finish.
  if (task.interruptedTurn) return { verdict: 'related', by: 'rule', rule: 'current-turn', reason: '宿主重启中断的当前轮次，允许跑完' };
  const identifier = task.issue?.identifier?.toUpperCase();
  // Tasks without a Linear issue only come from an owner's own submit.
  if (!identifier) return { verdict: 'related', by: 'rule', rule: 'owner-task', reason: '本机手动提交的任务（无 Linear 单）' };
  if ((focus.rejected || []).includes(identifier)) return { verdict: 'unrelated', by: 'owner', rule: 'owner-reject', reason: `owner 已判定 ${identifier} 与聚焦无关（focus-reject）` };
  const rule = relatedByRules({ focus, candidate: localCandidate(task, state) });
  if (rule) return { ...rule, by: 'rule' };
  const cached = focus.decisions?.[identifier];
  if (cached && cached.revision === focus.revision) return cached;
  const pending = focus.pending?.[identifier];
  if (pending && pending.revision === focus.revision) return { verdict: 'pending', by: pending.by || 'judge', reason: pending.reason, judge: pending.verdict };
  return { verdict: 'unknown', by: 'none', reason: '等待相关性判断' };
}

// Wakes of a settled round (condition / timer, comment, data version). A wake that is known to be unrelated is not
// taken at all: the event stays unseen (like a user hold) and is taken once focus relates the task again. Otherwise
// it would queue the round, set resumeNotice (Linear shows "in progress") and spend a maxWakeups unit on a round
// the start gate then freezes.
const WAKE_PATHS = new Set(['wake', 'comment', 'data']);

/** automaticBlock's focus part. Starts are gated; wakes only when the task is already judged unrelated. */
export function focusBlock(task, state, path) {
  if (!focusOn(state)) return null;
  if (WAKE_PATHS.has(path)) {
    const d = focusDecision(task, state);
    return d.verdict === 'unrelated' ? { code: FOCUS_HELD, path, reason: `聚焦模式：与聚焦无关，暂不唤醒（${d.reason}）`, decision: d } : null;
  }
  if (path !== 'start') return null;
  const d = focusDecision(task, state);
  if (d.verdict === 'related') return null;
  if (d.verdict === 'unrelated') return { code: FOCUS_HELD, path, reason: `聚焦模式：与聚焦无关，已冻结（${d.reason}）`, decision: d };
  return { code: FOCUS_PENDING, path, reason: d.verdict === 'pending' ? `聚焦模式：待 owner 确认（${d.reason}）` : '聚焦模式：等待相关性判断', decision: d };
}

const now = () => new Date().toISOString();
const focusTasks = state => state.tasks.filter(t => t.owner !== 'human');

/**
 * What the focus pass would change (pure): holds to set or release, related decisions to audit, and the
 * identifiers that need the judge. Apply with applyFocusActions under the aggregate lock (recomputed there).
 */
export function focusActions(state) {
  const actions = [], judge = [];
  const focus = state.focus;
  for (const task of focusTasks(state)) {
    if (!focusOn(state)) { if (focusHeld(task)) actions.push({ type: 'release', taskId: task.id, reason: '聚焦模式已退出' }); continue; }
    const held = focusHeld(task);
    if (task.status !== 'queued' && !held) continue;
    const d = focusDecision(task, state);
    const mark = `${focus.revision}:${d.verdict}`;
    if (d.verdict === 'related') {
      if (held) actions.push({ type: 'release', taskId: task.id, reason: d.reason, decision: d });
      else if (task.focusMark !== mark) actions.push({ type: 'related', taskId: task.id, decision: d });
      continue;
    }
    // A focus-held task that left the queue (window expired, stopped) keeps its hold until it is related again.
    if (task.status !== 'queued' || userHeld(task)) continue;
    if (d.verdict === 'unrelated') {
      if (!(held && task.hold.revision === focus.revision)) actions.push({ type: 'hold', taskId: task.id, decision: d });
    } else {
      if (task.focusMark !== mark) actions.push({ type: 'mark', taskId: task.id, decision: d });
      if (d.verdict === 'unknown') judge.push({ taskId: task.id, identifier: task.issue.identifier.toUpperCase(), revision: focus.revision });
    }
  }
  const seen = new Set();
  return { actions, judge: judge.filter(j => !seen.has(j.identifier) && seen.add(j.identifier)) };
}

/** Applies focusActions(state) on the locked draft; returns whether anything changed. */
export function applyFocusActions(state) {
  const { actions } = focusActions(state);
  for (const a of actions) {
    const task = state.tasks.find(t => t.id === a.taskId);
    const events = (task.events ||= []);
    const revision = state.focus?.revision ?? null;
    if (a.type === 'release') {
      events.push({ action: 'focus-release', hold: task.hold, reason: a.reason, ...(a.decision ? { rule: a.decision.rule, by: a.decision.by } : {}), revision, at: now() });
      delete task.hold;
      if (a.decision) task.focusMark = `${revision}:related`;
    } else if (a.type === 'related') {
      events.push({ action: 'focus-related', by: a.decision.by, rule: a.decision.rule, reason: a.decision.reason, revision, at: now() });
      task.focusMark = `${revision}:related`;
    } else if (a.type === 'hold') {
      task.hold = { by: 'focus', reason: a.decision.reason, revision, at: now() };
      events.push({ action: 'focus-held', by: a.decision.by, rule: a.decision.rule, reason: a.decision.reason, revision, at: now() });
      task.focusMark = `${revision}:unrelated`;
    } else if (a.type === 'mark') {
      events.push({ action: a.decision.verdict === 'pending' ? 'focus-pending' : 'focus-judging', reason: a.decision.reason, revision, at: now() });
      task.focusMark = `${revision}:${a.decision.verdict}`;
    }
  }
  return actions.length > 0;
}

// Every focus change starts a new revision. Adding issues cannot make a related task unrelated, so an add keeps
// the current revision's 'related' decisions (carried to the new revision); unrelated and pending ones are judged
// again, since the added issues may relate them. Any other change (set, remove, clear) drops all decisions.
function bump(focus, at, { keepRelated = false } = {}) {
  const old = focus.revision || 0;
  focus.revision = old + 1;
  const kept = {};
  if (keepRelated) for (const [issue, d] of Object.entries(focus.decisions || {}))
    if (d?.verdict === 'related' && d.revision === old) kept[issue] = { ...d, revision: focus.revision };
  focus.decisions = kept; focus.pending = {};
  focus.changedAt = at;
}
/** Issues on the chains of the tasks of an issue (focus-approve adds the whole chain). */
function chainOfIssue(state, identifier) {
  const out = new Set([identifier]);
  for (const t of state.tasks) if (t.issue?.identifier?.toUpperCase() === identifier) for (const i of chainIssues(t, state)) out.add(i);
  return [...out];
}

/**
 * Focus commands on the locked draft: focus-set {issues, intent}, focus-add {issues}, focus-remove {issues},
 * focus-clear, focus-approve {issue}, focus-reject {issue}, plus the owner-action add (owner-add). Holds are
 * released or set in the same section.
 */
export function focusCommand(state, request, at = now()) {
  const action = request.action;
  const focus = (state.focus ||= { enabled: false, issues: [], intent: '', revision: 0, decisions: {}, pending: {}, rejected: [] });
  focus.decisions ||= {}; focus.pending ||= {}; focus.rejected ||= []; focus.issues ||= [];
  const log = extra => { (state.opsLog ||= []).push({ action, at, ...extra }); if (state.opsLog.length > 50) state.opsLog.splice(0, state.opsLog.length - 50); };
  if (action === 'focus-set') {
    const issues = normalizeIssues(request.issues || []);
    if (!issues.length) throw new Error('focus-set needs at least one issue identifier');
    Object.assign(focus, { enabled: true, issues, intent: String(request.intent || '').slice(0, 2000), since: at, rejected: [] });
    bump(focus, at); log({ issues, intent: focus.intent });
  } else if (action === 'focus-add' || action === 'owner-add') {
    if (!focus.enabled) throw new Error('Focus mode is off; use focus-set');
    const issues = normalizeIssues(request.issues || []).filter(i => !focus.issues.includes(i));
    if (!issues.length) return false;
    focus.issues.push(...issues); focus.rejected = focus.rejected.filter(i => !issues.includes(i));
    // A new intent can change what counts as related: then nothing is kept.
    const intentChanged = request.intent !== undefined && String(request.intent).slice(0, 2000) !== focus.intent;
    if (request.intent !== undefined) focus.intent = String(request.intent).slice(0, 2000);
    bump(focus, at, { keepRelated: !intentChanged }); log({ issues, ...(request.by ? { by: request.by } : {}) });
  } else if (action === 'focus-remove') {
    if (!focus.enabled) throw new Error('Focus mode is off');
    const issues = normalizeIssues(request.issues || []);
    focus.issues = focus.issues.filter(i => !issues.includes(i));
    bump(focus, at); log({ issues });
  } else if (action === 'focus-clear') {
    if (!focus.enabled) return false;
    focus.enabled = false; focus.clearedAt = at;
    bump(focus, at); log({});
  } else if (action === 'focus-approve') {
    if (!focus.enabled) throw new Error('Focus mode is off');
    const [issue] = normalizeIssues(request.issue);
    if (!issue) throw new Error('focus-approve needs an issue identifier');
    const issues = chainOfIssue(state, issue).filter(i => !focus.issues.includes(i));
    focus.issues.push(...issues); focus.rejected = focus.rejected.filter(i => i !== issue);
    bump(focus, at, { keepRelated: true }); log({ issue, added: issues });
  } else if (action === 'focus-reject') {
    if (!focus.enabled) throw new Error('Focus mode is off');
    const [issue] = normalizeIssues(request.issue);
    if (!issue) throw new Error('focus-reject needs an issue identifier');
    if (!focus.rejected.includes(issue)) focus.rejected.push(issue);
    delete focus.pending[issue];
    focus.decisions[issue] = { verdict: 'unrelated', by: 'owner', rule: 'owner-reject', reason: `owner 判定 ${issue} 与聚焦无关`, revision: focus.revision, at };
    log({ issue });
  } else throw new Error(`Unknown focus command ${action}`);
  applyFocusActions(state);
  return true;
}

/** Records a rule / judge result for (identifier, revision); dropped when focus changed meanwhile. */
export function recordJudgement(state, { identifier, revision, taskId }, decision, at = now()) {
  const focus = state.focus;
  if (!focus?.enabled || focus.revision !== revision) return false;
  const entry = { verdict: decision.verdict, by: decision.by, ...(decision.rule ? { rule: decision.rule } : {}),
    reason: String(decision.reason || '').slice(0, 500), revision, at, ...(taskId ? { taskId } : {}) };
  if (entry.verdict === 'related' || entry.verdict === 'unrelated') { focus.decisions[identifier] = entry; delete focus.pending[identifier]; }
  else focus.pending[identifier] = { ...entry, verdict: entry.verdict === 'error' ? 'error' : 'uncertain' };
  const task = state.tasks.find(t => t.id === taskId);
  task?.events.push({ action: 'focus-judged', verdict: entry.verdict, by: entry.by, rule: entry.rule, reason: entry.reason, revision, at });
  applyFocusActions(state);
  return true;
}

/** The snapshot's focus block. */
export function focusView(state) {
  const f = state.focus;
  if (!f) return { enabled: false, issues: [], intent: '', revision: 0, pending: [], held: [], decisions: [] };
  const current = e => e.revision === f.revision;
  return { enabled: Boolean(f.enabled), issues: f.issues || [], intent: f.intent || '', revision: f.revision || 0, since: f.since || null,
    rejected: f.rejected || [],
    pending: f.enabled ? Object.entries(f.pending || {}).filter(([, e]) => current(e)).map(([issue, e]) => ({ issue, ...e })) : [],
    decisions: f.enabled ? Object.entries(f.decisions || {}).filter(([, e]) => current(e)).map(([issue, e]) => ({ issue, ...e })) : [],
    held: state.tasks.filter(focusHeld).map(t => ({ id: t.id, issue: t.issue?.identifier || null, status: t.status, reason: t.hold.reason })) };
}

/** The judge's input for one candidate. Bounded excerpts only. */
export function judgeInput(state, candidate) {
  return { focus: { issues: state.focus?.issues || [], intent: state.focus?.intent || '' },
    candidate: { identifier: candidate.identifier, title: String(candidate.title || '').slice(0, 300),
      description: String(candidate.description || '').slice(0, 4000), parent: candidate.parent || null,
      children: (candidate.children || []).slice(0, 50),
      comments: (candidate.comments || []).slice(-8).map(c => String(c).slice(0, 800)),
      mentions: mentionHints({ focus: state.focus, candidate }) } };
}
