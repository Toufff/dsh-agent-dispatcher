import { z } from 'zod';

const text = z.string().trim().min(1).max(2000);
export const workItemsSchema = z.array(z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/), title: text,
  status: z.enum(['ready', 'blocked', 'decision', 'done']),
  dependsOn: z.array(z.string().max(80)).max(40),
  action: z.string().max(2000), evidence: z.array(text).max(20),
  blocker: z.object({ kind: z.enum(['external', 'task', 'permission', 'time']),
    owner: text, reason: text, resumeWhen: text }).strict().optional()
// Bounds one round's reported items. The dispatcher keeps completed items itself (mergeLedger),
// so this limit no longer grows with the length of a follow-up chain.
}).strict()).min(1).max(200);

/**
 * The dispatcher owns the full ledger. A round may omit previously completed (done) items;
 * they are restored from the stored ledger in their original order. Unfinished items must
 * still be reported, so open work can never silently disappear.
 */
export function mergeLedger(items, previous = []) {
  if (!items || !previous.length) return items;
  const reported = new Map(items.map(item => [item.id, item]));
  // An omitted item keeps its stored state: done stays done, an unfinished one stays open (it is never
  // silently dropped, and the round is not rejected for leaving it out).
  const merged = previous.map(old => reported.get(old.id) || old);
  const known = new Set(previous.map(old => old.id));
  return [...merged, ...items.filter(item => !known.has(item.id))];
}

/** Prompt view of the stored ledger: unfinished items in full, completed items as a compact index. */
export function ledgerPrompt(items = [], recentDone = 40) {
  const open = items.filter(i => i.status !== 'done'), done = items.filter(i => i.status === 'done');
  const shown = done.slice(-recentDone), hidden = done.length - shown.length;
  return `Unfinished workItems (report every one of these, with its current status):\n${JSON.stringify(open)}\n` +
    `Completed workItems retained by the dispatcher (${done.length}; do NOT repeat them in your result, reference their IDs in dependsOn when needed${hidden ? `; ${hidden} older ones omitted here are retained too` : ''}):\n` +
    (shown.map(i => `- ${i.id}: ${i.title}`).join('\n') || '- none');
}

export const decisionItems = task => (task.workItems || []).filter(i =>
  i.status !== 'done' && (i.status === 'decision' || i.blocker?.kind === 'permission'));

// Explicit stage IDs only. Natural-language dates/reasons never grant a wake.
export function waitScopeError(wait, items = [], decision = false) {
  if (!wait) return null;
  const needsScope = decision || decisionItems({ workItems: items }).length > 0;
  if (!wait.workItemIds) return needsScope ? 'Mixed permission waits require explicit independent wait.workItemIds.' : null;
  const ids = wait.workItemIds, byId = new Map(items.map(i => [i.id, i]));
  if (new Set(ids).size !== ids.length || !ids.length) return 'wait.workItemIds must be unique and nonempty.';
  for (const id of ids) {
    const item = byId.get(id);
    if (!item || item.status !== 'blocked' || !item.blocker || item.blocker.kind === 'permission' ||
        !item.dependsOn.every(dep => byId.get(dep)?.status === 'done'))
      return 'Wait scope must reference independent blocked stages with completed dependencies, never permission stages.';
    const kinds = wait.kind === 'linear' ? ['external', ...(wait.recheckAt ? ['time'] : [])] : [wait.kind];
    if (!kinds.includes(item.blocker.kind)) return 'Wait kind must match its scoped stage blocker.';
  }
  return null;
}

// Claims are checked for consistency, never promoted to verified production facts.
export function workflowError(outcome, previous = [], required = false, reportedIds = null) {
  const items = outcome.workItems;
  const scopeError = waitScopeError(outcome.wait, items, outcome.status === 'decision');
  if (scopeError) return scopeError;
  if (!items) return required || previous.length ? 'Return workItems covering the whole goal, including all unfinished stages.' : null;
  const byId = new Map(items.map(item => [item.id, item]));
  if (byId.size !== items.length) return 'workItems IDs must be unique.';
  for (const old of previous) {
    const item = byId.get(old.id);
    if (!item) return 'Do not drop previously recorded unfinished workItems; report every ready, blocked and decision stage.';
    if (old.status === 'done' && item.status !== 'done') return 'Do not replay completed workItems; add a new verification or correction item.';
  }
  const visiting = new Set(), visited = new Set();
  function visit(id) {
    if (visiting.has(id)) return false;
    if (visited.has(id)) return true;
    const item = byId.get(id);
    if (!item) return false;
    visiting.add(id);
    if (!item.dependsOn.every(visit)) return false;
    visiting.delete(id); visited.add(id); return true;
  }
  if (!items.every(item => visit(item.id))) return 'workItems dependencies must exist and must not form cycles.';
  for (const item of items) {
    const dependenciesDone = item.dependsOn.every(id => byId.get(id).status === 'done');
    if (item.status === 'done' && (!item.evidence.length || !dependenciesDone || item.blocker))
      return 'Completed workItems require evidence, completed dependencies and no blocker.';
    if (item.status === 'ready' && (!dependenciesDone || !item.action.trim() || item.blocker))
      return 'Ready workItems require satisfied dependencies, a concrete authorized action and no blocker.';
    if (['blocked', 'decision'].includes(item.status) && !item.blocker)
      return 'Every blocked/decision workItem needs a specific typed blocker and observable resumption condition.';
    if (item.status === 'decision' && item.blocker.kind !== 'permission')
      return 'Decision workItems must identify the concrete local decision/permission.';
  }
  // Ready stages the round itself reported decide continue vs. stop; stages restored from the stored
  // ledger keep their old state and are reported again next round.
  const ready = items.some(item => item.status === 'ready' && (!reportedIds || reportedIds.has(item.id)));
  const done = items.every(item => item.status === 'done');
  if (ready && outcome.status !== 'continue') return 'Authorized ready workItems remain: return continue, not whole-task blocked/complete/decision.';
  if (outcome.status === 'continue' && !ready) return 'Continue requires at least one ready authorized workItem.';
  if ((outcome.status === 'complete') !== done) return 'Complete requires every recorded stage to be done; stage completion is not goal completion.';
  if (['blocked', 'decision'].includes(outcome.status) && !outcome.wait && items.some(item =>
    item.status === 'blocked' && item.blocker.kind === 'time' && item.dependsOn.every(id => byId.get(id).status === 'done')))
    return 'Independent timed stages require an explicit structured wait; a permission decision must not cancel their scheduled verification. Supply the known timezone-aware timestamp, never infer one.';
  return null;
}

export const workflowProtocol = `
Independent waiting stages MUST retain a structured wait even when a different stage requires permission. For mixed permission/wait results, bind wait.workItemIds to the stable IDs of independent blocked stages with completed dependencies; never include a permission stage. A time wait requires a time blocker; Linear waits bind external blockers (or time blockers with recheckAt). Do not put dates only in prose. Use decision plus a scoped wait when human attention and independent monitoring coexist. On wake perform ONLY scoped already-authorized work, retain every pending decision and never interpret a timer/reply as approval.
REQUIRED workItems ledger: cover the ENTIRE requested goal, not just this turn. Each item has {"id":"stable-id","title":"stage or requirement","status":"ready|blocked|decision|done","dependsOn":[],"action":"authorized next action or empty","evidence":[]}. Blocked/decision items also require "blocker":{"kind":"external|task|permission|time","owner":"actual responsible party","reason":"precise missing input","resumeWhen":"observable condition"}. Keep stable IDs, never drop unfinished items, never replay done items. Completed (done) items from earlier rounds are retained by the dispatcher: do not repeat them, report only unfinished items plus items you added or completed this round. Done requires actual evidence; evidence is a claim pending independent verification/human acceptance. Record code, merge, deployment and acceptance as separate items WHEN requested; do not invent extra scope. A production permission blocker must not stop independent local development. Only mark ready actions already permitted by current local instructions. If any ready item remains, return continue even if another item is blocked. The ledger never grants permission or changes local policy. If all items are blocked, declare a real wait or a concrete local decision; do not call an unknown dependency an external blocker without checking its applicability.
`;

export function issueKey(task, state) {
  if (!task.issue?.id) return null;
  const mapping = state.settings.projects.find(p => p.id === task.projectId)?.linear;
  return JSON.stringify([mapping?.workspaceId || task.projectId, task.issue.id]);
}
export function currentTask(task, state) {
  if (task.supersededBy) return false;
  const key = issueKey(task, state);
  return !key || state.tasks.findLast(t => issueKey(t, state) === key)?.id === task.id;
}

// Round history grows with every automatic round. A long task re-reports its whole ledger each round
// (hundreds of items), so keeping every copy makes the stored state grow quadratically and slows every
// dispatcher action that loads and saves it. Only the latest round keeps its full outcome; once a newer
// round arrives, the older one keeps just {id, status, evidence} for items whose status or evidence
// changed since earlier rounds. That preserves what continuationPolicy reads: whether an item was ever
// done and every distinct evidence list it has had.
const roundItemKey = item => JSON.stringify([item.status, item.evidence || []]);
export function compactRound(earlier, round) {
  if (round.compacted || !Array.isArray(round.outcome?.workItems)) return round;
  const last = new Map();
  for (const r of earlier) for (const item of r.outcome?.workItems || []) last.set(item.id, roundItemKey(item));
  const workItems = round.outcome.workItems.filter(item => last.get(item.id) !== roundItemKey(item))
    .map(item => ({ id: item.id, status: item.status, evidence: item.evidence || [] }));
  return { ...round, outcome: { ...round.outcome, workItems }, compacted: true };
}
export function archiveRound(task, round) {
  task.rounds ||= [];
  const k = task.rounds.length - 1;
  if (k >= 0) task.rounds[k] = compactRound(task.rounds.slice(0, k), task.rounds[k]);
  task.rounds.push(round);
}

// Evidence remains an executor claim. Changing prose alone cannot renew a budget.
export function continuationPolicy(task, outcome, maxAutoRounds = 40) {
  const normalize = value => value.trim().replace(/\s+/g, ' ');
  const history = [...(task.rounds || []).flatMap(r => r.outcome?.workItems || []), ...(task.workItems || [])];
  const checkpoint = (outcome.workItems || []).some(item => {
    const old = history.filter(previous => previous.id === item.id);
    if (!old.length || old.some(previous => previous.status === 'done')) return false;
    if (item.status === 'done' && !old.some(previous => previous.status === 'done')) return true;
    const seen = new Set(old.flatMap(previous => previous.evidence).map(normalize));
    return item.evidence.some(value => !seen.has(normalize(value)));
  });
  const idle = checkpoint ? 0 : (task.continuationIdleRounds ?? task.autoRounds ?? 0);
  const budget = (task.autoRounds || 0) >= maxAutoRounds || idle >= 3;
  const progress = checkpoint || Boolean(outcome.progress.trim()) && outcome.progress !== task.lastProgress;
  return { repeat: progress && !budget, idle: checkpoint ? 0 : idle + 1, checkpoint,
    stop: budget ? 'budget' : 'no-progress' };
}

// One durable local owner/action, consumed by both the panel and notification path.
export function attentionFor(task, state) {
  if (!currentTask(task, state)) return null;
  let reason;
  if (task.status === 'stalled') reason = task.continuationStop === 'budget' ? '自动续办预算已用完' : '本轮没有可确认的新进展';
  else if (task.status === 'needs_result') reason = '结果或阶段清单校验失败';
  else if (task.status === 'decision') reason = '需要具体决策或授权';
  else if (task.status === 'blocked' && task.events?.at(-1)?.action === 'window-expired')
    reason = '继承的执行时段已过期，本轮未启动；可按本轮要求重新核定执行时机';
  else if (task.status === 'blocked' && ['invalid', 'expired', 'limit'].includes(task.wait?.status))
    reason = { invalid: '等待配置无效', expired: '等待时段已过期', limit: '自动唤醒预算已用完' }[task.wait.status];
  else if (task.status === 'blocked' && !task.wait) reason = '阻塞未设置可触发的恢复条件';
  if (!reason && task.status === 'blocked' && decisionItems(task).length) return {
    owner: '本地负责人', reason: '部分阶段需要决定；独立阶段继续监控',
    action: '仅处理待审批阶段的具体决定；独立阶段按已登记条件复核，唤醒不代表审批通过。'
  };
  if (!reason) return null;
  return { owner: '本地负责人', reason,
    action: '核对剩余阶段和有效约束，补充本轮要求后继续，或修正恢复条件；不会自动扩大权限或重做已完成步骤。' };
}
