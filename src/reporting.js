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
    if (shareable(wait.condition, secrets) && mapping?.shareProgress) body += `\n需核对：${wait.condition}`;
    if (wait.notBefore) body += `\n最早核对时间：${wait.notBefore}`;
    if (wait.expiresAt) body += `\n窗口截止：${wait.expiresAt}（过期不执行）`;
  }
  return body;
}
