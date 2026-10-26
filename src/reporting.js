import { outcomeReports } from './outcome.js';
import { waitFaults } from './followup.js';
import { attentionFor } from './workflow.js';

// Conservative accidental-disclosure guard, not a general-purpose DLP system.
export function shareable(text, secrets = []) {
  if (!text || secrets.some(s => s && text.includes(s))) return false;
  return !/(?:[A-Za-z]:[\\/]|\\\\|\/(?:Users|home|tmp|var|etc|mnt)\/|(?:lin_api_|sk-|ghp_|github_pat_|Bearer\s)[\w-]+|-----BEGIN .*PRIVATE KEY|(?:password|api[_ -]?key|token|secret)\s*[:=]\s*\S+)/i.test(text);
}

export function reportBody(task, mapping, secrets) {
  let body = outcomeReports[task.status] || '本地已收到新的条件变化，正在排队重新核对；这不代表已获得执行授权。';
  const attention = attentionFor(task, { tasks: [task], settings: { projects: [] } });
  if (attention) body += `\n\n下一责任：${attention.owner}。${attention.reason}。${attention.action}`;
  if (task.workItems) body += `\n阶段进度（执行者报告，非独立验收）：${task.workItems.filter(i => i.status === 'done').length}/${task.workItems.length} 完成。`;
  if (mapping?.shareProgress && shareable(task.outcome?.publicSummary, secrets))
    body += `\n\n${task.outcome.publicSummary}`;
  if (task.wait) {
    const wait = task.wait;
    if (wait.workItemIds?.length) body += '\n独立阶段单独监控；待审批阶段仍未授权，回复或到点不会解除审批。';
    body += `\n\n恢复监控：${({ validating: '正在校验目标', watching: '监听中', invalid: '目标配置无效', expired: '已过期', suspended: '已停止', triggered: '已触发核验', resolved: '已结束', superseded: '已被续办替代', limit: '达到唤醒上限' })[wait.status] || wait.status}。`;
    // Never publish arbitrary exception text (paths/tokens may occur in it).
    if (wait.status === 'invalid') body += `\n${waitFaults[wait.errorCode] || '等待目标配置无效：只能监听当前工单、同项目直接子单或 Linear 明确关联的工单。'}已停止重试，需本地负责人修正后重新保存；未启动执行。`;
    else if (wait.failureNotified) body += '\n本地条件监听连续失败至少 3 次，正在自动复核；目前无法确认新回复或恢复条件，未启动执行。接收方需检查本地连接、配置和原执行器。';
    else if (wait.recoveredAt) body += `\n本地条件监听已于 ${wait.recoveredAt} 恢复，后续仍按原条件核对；恢复连接不等于任务完成或新增授权。`;
    if (shareable(wait.condition, secrets) && mapping?.shareProgress) body += `\n需核对：${wait.condition}`;
    if (wait.notBefore) body += `\n最早核对时间：${wait.notBefore}`;
    if (wait.recheckAt) body += `\n独立复查：${wait.recheckAt}（无回复也复查，不代表条件满足或新增授权）`;
    if (wait.expiresAt) body += `\n窗口截止：${wait.expiresAt}（过期不执行）`;
    if (wait.status === 'expired') body += '\n下一责任：本地负责人核对执行约束并重新安排有效等待；重复评论或对方催办不能解除过期门。';
    if (wait.kind === 'task') body += '\n等待本机依赖任务的已完成结果；由调度器检查持久回执，不依赖本人或协作者转发评论，不代表人工验收。';
    if (wait.pendingUpdate) body += '\n窗口过期后已收到新的协作者回复，已保留记录；接收方需确认新的有效窗口，未启动执行。';
  }
  return body;
}
