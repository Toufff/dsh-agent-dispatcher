import { z } from 'zod';
import { waitSchema } from './followup.js';

const text = z.string().trim().min(1).max(2000);
const schema = z.object({
  status: z.enum(['complete', 'continue', 'blocked', 'decision']),
  evidence: z.array(text).max(20),
  remaining: z.array(text).max(20),
  next: z.string().max(2000),
  progress: z.string().max(2000),
  blockers: z.array(z.object({ owner: text, reason: text, resumeWhen: text }).strict()).max(20),
  wait: waitSchema.optional(),
  publicSummary: z.string().trim().min(1).max(4000).optional()
}).strict();

export const outcomeProtocol = `
Local dispatcher result contract (does not expand authorization):
Work until the acceptance conditions are met or no authorized useful next step remains. Separate independent work from external dependencies. Never bypass approvals, repository rules or local restrictions. Do not repeat unsuccessful work without a new approach.
End your final response with exactly one <dispatch-result>JSON</dispatch-result> block:
{"status":"complete|continue|blocked|decision","evidence":["verification actually performed"],"remaining":["unfinished requirement"],"next":"concrete authorized next step, or empty","progress":"new evidence or change this round, or empty if none","blockers":[{"owner":"responsible party","reason":"specific dependency","resumeWhen":"observable resumption condition"}]}
Use complete only when ALL requirements are verified, with nonempty evidence and no remaining items/blockers/next. Use continue if useful authorized local work remains, even when other items are externally blocked. Use blocked only when no local step remains; name dependency owners and resumption conditions. Use decision only for a concrete human decision/permission. Report failures and incomplete validation honestly. Do not put credentials in the result. The full structured result stays local; only the opt-in publicSummary and safe wait details may be shared.
For blocked/decision, next may describe the conditional future step or be empty; it never authorizes automatic execution. Only continue executes a next step. Linear waits may have an expiresAt without notBefore; that is a monitoring deadline, not a new execution window. Time waits always require notBefore. If both timestamps exist, expiresAt must be later.
For blocked results you MAY add "wait":{"kind":"linear|time","condition":"what must be verified","issueId":"UUID of the actual receipt issue: current issue, direct child, or explicitly related/blocking issue in the same Linear project (optional)","notBefore":"ISO timestamp with timezone (optional for linear, required for time)","expiresAt":"ISO end of an explicitly authorized window (optional)"}. Omit unused fields. Subscribe where the producer actually posts receipts; do not require manual forwarding onto this issue. The server verifies direct Linear relations; prose references and unrelated same-project tickets do not qualify. A proposed window is NOT an authorized window. Use a linear wait for pending confirmation. A time wake only schedules a recheck; it grants no permission. Never use decision for a condition that can simply be checked later. Record existing handoff IDs; do not invent or duplicate tickets.
You MAY add "publicSummary" containing a concise shareable business update: completed work, actual validation, remaining work, responsible party, and exact resumption condition/time with timezone. Exclude local paths, credentials, transcripts and private identifiers. Only locally opted-in projects publish this field. Never claim a proposal, simulated test or process exit is production acceptance.
Waiting for another task ON THIS RECEIVER is NOT a collaborator-comment wait. Use "wait":{"kind":"task","taskId":"existing local task ID","condition":"result to verify"}, or issueId with that task's existing Linear UUID/identifier if its local task ID is unavailable. The dispatcher binds exactly one existing task in the same local project and rejects self-dependencies, cycles and ambiguous references. It wakes only on a confirmed complete result, not on failed/blocked/stopped work, and does not mark human acceptance. Never invent task identities. Remote tasks still use linear waits.
For a linear wait, you MUST specify expectedAuthorIds with the actual Linear user IDs of the people whose replies are required, not role words. These must be allowed by local policy and cannot be the receiver's own author. Do not use a peer comment to proxy a local task result. If local instructions or an expired execution window prevent any authorized action, report the concrete local decision needed; do not wait for a peer to remove local restrictions. Never extend a deadline yourself.
`;

export function inspectOutcome(summary) {
  const invalid = error => ({ outcome: null, error });
  const matches = [...(summary || '').matchAll(/<dispatch-result>([\s\S]*?)<\/dispatch-result>/g)];
  if (matches.length !== 1) return invalid('Return exactly one dispatch-result block.');
  if (summary.slice(matches[0].index + matches[0][0].length).trim()) return invalid('The dispatch-result block must be the last content.');
  let result;
  try { result = JSON.parse(matches[0][1]); } catch { return invalid('The dispatch-result block must contain valid JSON.'); }
  const parsed = schema.safeParse(result);
  // Field paths and validator codes only: never echo private field values into diagnostic reports.
  if (!parsed.success) return invalid(parsed.error.issues.slice(0, 6).map(i => `${i.path.join('.') || 'result'}: ${i.code}`).join('; '));
  result = parsed.data;
  if (result.wait && result.status !== 'blocked') return invalid('Only blocked results may include wait.');
  if (result.status === 'complete' && (!result.evidence.length || result.remaining.length || result.blockers.length || result.next.trim())) return invalid('Complete requires evidence and empty remaining, blockers and next.');
  if (result.status === 'continue' && (!result.next.trim() || !result.remaining.length)) return invalid('Continue requires remaining work and a concrete next step.');
  // A blocked next step describes what follows the dependency; it is not a command to execute.
  if (['blocked', 'decision'].includes(result.status) && (!result.blockers.length || !result.remaining.length)) return invalid('Blocked/decision requires remaining work and named blockers.');
  return { outcome: result, error: null };
}
export const parseOutcome = summary => inspectOutcome(summary).outcome;

export const outcomeReports = {
  running: '本地 agent 已实际启动，正在处理；尚未完成。',
  failed: '本轮执行失败，已保留原会话与现场；不会换执行器重跑。接收方需核对执行回执后恢复。',
  exhausted: '本机执行器均明确未能启动，任务未执行；接收方需恢复可用执行器。',
  unknown: '本地执行回执持续不明确，正在自动核对；为防止重复操作，暂不启动另一执行器。',
  accepted: '接收方已在本地确认验收；Linear 的最终 Done 状态仍由人工管理。',
  review: '本地 agent 报告需求已完成并提供验证证据，等待人工验收；尚未标记 Done。',
  blocked: '本地执行存在外部依赖，当前无可继续的本地步骤；等待依赖满足后续办。尚未完成，不需要验收。',
  decision: '本地执行需要具体的人类决策或授权；尚未完成，不需要验收。请在接收方本地查看问题。',
  stalled: '自动续办达到次数或无进展限制；任务尚未完成，需要排查执行卡点，不是验收。',
  needs_result: '执行已结束，但结果分类无法确认；尚未满足验收条件。请在接收方检查结果格式。'
};
