import { z } from 'zod';

const text = z.string().trim().min(1).max(2000);
const schema = z.object({
  status: z.enum(['complete', 'continue', 'blocked', 'decision']),
  evidence: z.array(text).max(20),
  remaining: z.array(text).max(20),
  next: z.string().max(2000),
  progress: z.string().max(2000),
  blockers: z.array(z.object({ owner: text, reason: text, resumeWhen: text }).strict()).max(20)
}).strict();

export const outcomeProtocol = `
Local dispatcher result contract (does not expand authorization):
Work until the acceptance conditions are met or no authorized useful next step remains. Separate independent work from external dependencies. Never bypass approvals, repository rules or local restrictions. Do not repeat unsuccessful work without a new approach.
End your final response with exactly one <dispatch-result>JSON</dispatch-result> block:
{"status":"complete|continue|blocked|decision","evidence":["verification actually performed"],"remaining":["unfinished requirement"],"next":"concrete authorized next step, or empty","progress":"new evidence or change this round, or empty if none","blockers":[{"owner":"responsible party","reason":"specific dependency","resumeWhen":"observable resumption condition"}]}
Use complete only when ALL requirements are verified, with nonempty evidence and no remaining items/blockers/next. Use continue if useful authorized local work remains, even when other items are externally blocked. Use blocked only when no local step remains; name dependency owners and resumption conditions. Use decision only for a concrete human decision/permission. Report failures and incomplete validation honestly. Do not put credentials in the result. This structured result stays local; the remote notification contains only a fixed status message.
`;

export function parseOutcome(summary) {
  const matches = [...(summary || '').matchAll(/<dispatch-result>([\s\S]*?)<\/dispatch-result>/g)];
  if (matches.length !== 1 || summary.slice(matches[0].index + matches[0][0].length).trim()) return null;
  let result;
  try { result = schema.parse(JSON.parse(matches[0][1])); } catch { return null; }
  if (result.status === 'complete' && (!result.evidence.length || result.remaining.length || result.blockers.length || result.next.trim())) return null;
  if (result.status === 'continue' && (!result.next.trim() || !result.remaining.length)) return null;
  if (['blocked', 'decision'].includes(result.status) && (!result.blockers.length || !result.remaining.length || result.next.trim())) return null;
  return result;
}

export const outcomeReports = {
  accepted: '接收方已在本地确认验收；Linear 的最终 Done 状态仍由人工管理。',
  review: '本地 agent 报告需求已完成并提供验证证据，等待人工验收；尚未标记 Done。',
  blocked: '本地执行存在外部依赖，当前无可继续的本地步骤；等待依赖满足后续办。尚未完成，不需要验收。',
  decision: '本地执行需要具体的人类决策或授权；尚未完成，不需要验收。请在接收方本地查看问题。',
  stalled: '自动续办达到次数或无进展限制；任务尚未完成，需要排查执行卡点，不是验收。',
  needs_result: '执行已结束，但结果分类无法确认；尚未满足验收条件。请在接收方检查结果格式。'
};
