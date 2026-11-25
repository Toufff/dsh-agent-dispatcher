/**
 * Archiving completed stage ledger entries (task.workItems).
 *
 * The ledger is the executor's report of every stage of a goal, and the dispatcher keeps completed stages
 * forever so a stage can never be replayed and `dependsOn` keeps resolving. On a long chain that history
 * dominates the task record: LON-35 carried 1503 entries (1486 done), 517 349 characters of JSON, and every
 * round re-wrote and re-compared all of it for a handful of open stages (LON-160: 65 786 characters).
 *
 * Once a task has more done entries than `threshold`, the oldest ones are folded:
 * - the hot ledger keeps the entry itself (id, one-line title, status done, one evidence summary line) so
 *   `dependsOn` references, "never replay a done stage" and the prompt index keep working unchanged;
 * - the complete entry (every evidence item) moves to the archive with the task's durable history, in
 *   `archive/work-items/<taskId>.jsonl`, readable by id through ArchiveStore.workItems().
 * A store without an archive (legacy whole-state store, tests) keeps the complete entries in
 * task.archivedWorkItems.entries instead, so evidence is never dropped either way.
 *
 * followup.workItemArchive.enabled = false turns the fold off; entries already folded stay valid ledger items.
 */
// Marks an entry the fold already replaced. It is a normal evidence string, so the stored ledger still parses.
const MARK = '[archived] ';
// keep: the newest completed entries stay complete (they are what a continuation reads). evidenceChars: the
// stub keeps one truncated evidence line; the complete evidence is in the archive, so a hint is enough.
export const workItemArchiveDefaults = { enabled: true, threshold: 200, keep: 50, evidenceChars: 80 };
const TITLE_MAX = 120;
const schemaText = value => typeof value === 'string' ? value : '';
const oneLine = value => schemaText(value).replace(/\s+/g, ' ').trim();
const cut = (text, max) => text.length <= max ? text : `${text.slice(0, Math.max(1, max - 1))}…`;

/** Fold policy of one project (followup.workItemArchive), defaults first. */
export function workItemArchivePolicy(followup) {
  return { ...workItemArchiveDefaults, ...(followup?.workItemArchive || {}) };
}

/** True for an entry this fold already replaced with its summary. */
export function isFoldedWorkItem(item) {
  return item?.status === 'done' && Array.isArray(item.evidence) && item.evidence.length === 1 &&
    typeof item.evidence[0] === 'string' && item.evidence[0].startsWith(MARK);
}

/** The hot-ledger form: same id and status, one-line title, first evidence line as the summary. */
function foldedEntry(item, evidenceChars) {
  const first = (item.evidence || []).map(oneLine).find(Boolean);
  const summary = first ? `${MARK}${cut(first, evidenceChars)}` : `${MARK}no evidence recorded`;
  return { id: item.id, title: cut(oneLine(item.title) || String(item.id), TITLE_MAX), status: 'done',
    dependsOn: [], action: '', evidence: [cut(summary, 2000)] };
}

/**
 * Folds the oldest completed entries of a ledger. Order is preserved, open entries and the newest `keep`
 * completed ones are untouched, and an entry that was already folded is never folded again (so repeated
 * rounds are idempotent). before/after are the serialized ledger lengths, for measuring the effect; a ledger
 * that would not get smaller is returned unchanged.
 */
export function foldCompletedWorkItems(items = [], options = {}) {
  const { enabled, threshold, keep, evidenceChars } = { ...workItemArchiveDefaults, ...options };
  const list = Array.isArray(items) ? items : [];
  const before = JSON.stringify(list).length;
  const done = list.filter(item => item?.status === 'done');
  if (!enabled || done.length <= threshold)
    return { folded: [], workItems: list, before, after: before, done: done.length };
  const recent = new Set((keep > 0 ? done.slice(-keep) : []).map(item => item.id));
  const folded = [], workItems = [];
  for (const item of list) {
    if (item?.status === 'done' && !recent.has(item.id) && !isFoldedWorkItem(item)) {
      folded.push(item); workItems.push(foldedEntry(item, evidenceChars));
    } else workItems.push(item);
  }
  const after = JSON.stringify(workItems).length;
  // A ledger of already terse entries gains nothing (the stub has its own overhead): leave it as it is.
  if (after >= before) return { folded: [], workItems: list, before, after: before, done: done.length };
  return { folded, workItems, before, after, done: done.length };
}

/**
 * Folds one task's ledger in place: the complete entries reach the archive before the hot state drops them
 * (a crash at worst repeats an append; the reader keeps the last line per id). Returns the fold plan.
 */
export async function foldTaskWorkItems(task, state = {}, followup, now = Date.now()) {
  const plan = foldCompletedWorkItems(task.workItems || [], workItemArchivePolicy(followup));
  if (!plan.folded.length) return plan;
  const at = new Date(now).toISOString();
  if (state.archive) {
    await state.archive.archiveWorkItems(task.id, plan.folded, at);
    const previous = task.archivedWorkItems && !Array.isArray(task.archivedWorkItems) ? task.archivedWorkItems : {};
    task.archivedWorkItems = { count: (previous.count || 0) + plan.folded.length, lastAt: at };
  } else {
    const previous = Array.isArray(task.archivedWorkItems) ? task.archivedWorkItems : task.archivedWorkItems?.entries || [];
    task.archivedWorkItems = { count: previous.length + plan.folded.length, lastAt: at, entries: [...previous, ...plan.folded] };
  }
  task.workItems = plan.workItems;
  (task.events ||= []).push({ action: 'work-items-archived', count: plan.folded.length,
    before: plan.before, after: plan.after, at });
  return plan;
}

/** Complete entries folded out of a task's ledger, oldest first (empty when nothing was folded). */
export function archivedWorkItems(task, state = {}) {
  if (state.archive) return state.archive.workItems(task?.id);
  const kept = task?.archivedWorkItems;
  return Array.isArray(kept) ? kept : kept?.entries || [];
}
