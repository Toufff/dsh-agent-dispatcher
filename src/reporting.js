import { outcomeReports } from './outcome.js';

// Conservative accidental-disclosure guard, not a general-purpose DLP system.
export function shareable(text, secrets = []) {
  if (!text || secrets.some(s => s && text.includes(s))) return false;
  return !/(?:[A-Za-z]:[\\/]|\\\\|\/(?:Users|home|tmp|var|etc|mnt)\/|(?:lin_api_|sk-|ghp_|github_pat_|Bearer\s)[\w-]+|-----BEGIN .*PRIVATE KEY|(?:password|api[_ -]?key|token|secret)\s*[:=]\s*\S+)/i.test(text);
}

export function reportBody(task, mapping, secrets) {
  let body = outcomeReports[task.status] || '本地已收到新的条件变化，正在排队重新核对；这不代表已获得执行授权。';
  if (mapping?.shareProgress && shareable(task.outcome?.publicSummary, secrets))
    body += `\n\n${task.outcome.publicSummary}`;
  if (task.wait) {
    const wait = task.wait;
    body += `\n\n恢复监控：${wait.status}。`;
    // Never publish arbitrary exception text (paths/tokens may occur in it).
    if (wait.failureNotified) body += '\n本地条件监听连续失败至少 3 次，正在自动复核；目前无法确认新回复或恢复条件，未启动执行。接收方需检查本地连接、配置和原执行器。';
    else if (wait.recoveredAt) body += `\n本地条件监听已于 ${wait.recoveredAt} 恢复，后续仍按原条件核对；恢复连接不等于任务完成或新增授权。`;
    if (shareable(wait.condition, secrets) && mapping?.shareProgress) body += `\n需核对：${wait.condition}`;
    if (wait.notBefore) body += `\n最早核对时间：${wait.notBefore}`;
    if (wait.expiresAt) body += `\n窗口截止：${wait.expiresAt}（过期不执行）`;
    if (wait.pendingUpdate) body += '\n窗口过期后已收到新的协作者回复，已保留记录；接收方需确认新的有效窗口，未启动执行。';
  }
  return body;
}
