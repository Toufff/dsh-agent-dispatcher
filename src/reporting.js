import { outcomeReports } from './outcome.js';
import { waitFaults } from './followup.js';
import { attentionFor } from './workflow.js';
import { execFileSync } from 'node:child_process';
import { readdirSync, existsSync } from 'node:fs';
import path from 'node:path';

const SUMMARY_LIMIT = 6000;
// Where the full conclusion lives in the task's repository: Linear comments stay short, the repo does not.
// Returns '' when the task has no issue directory or the repository cannot be read.
export function repoPointer(task) {
  try {
    const id = task.issue?.identifier, cwd = task.cwd;
    if (!id || !cwd) return '';
    const dir = readdirSync(path.join(cwd, 'strategies'), { withFileTypes: true })
      .find(d => d.isDirectory() && (d.name === id || d.name.startsWith(id + '-')))?.name;
    if (!dir) return '';
    const rel = `strategies/${dir}/` + (existsSync(path.join(cwd, 'strategies', dir, 'report.md')) ? 'report.md' : '');
    const git = args => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 10000, windowsHide: true }).trim();
    const hash = git(['log', '-1', '--format=%h', '--', `strategies/${dir}`]);
    const remote = git(['remote', 'get-url', 'origin']).replace(/^git@([^:]+):/, 'https://$1/').replace(/\.git$/, '');
    const url = remote.startsWith('https://') && hash ? `${remote}/blob/${hash}/${rel}` : '';
    return `完整结论在 Git 仓库：${url || rel}${hash ? `（提交 ${hash}，路径 \`${rel}\`）` : ''}`;
  } catch { return ''; }
}
export function summaryText(text) {
  return text.length > SUMMARY_LIMIT ? `${text.slice(0, SUMMARY_LIMIT)}\n\n……（摘要过长已截断，全文见下方仓库链接）` : text;
}

const DIGEST_LIMIT = 30000;
// Several collected round results as one comment. When they do not fit, the older rounds shrink to their first
// line (round number and progress) plus the repository link; the newest rounds stay in full.
export function roundsDigest(rounds) {
  const head = `ZRSTUDIO：自动续办 ${rounds.length} 轮的结果合并回写（${rounds[0].at.slice(5, 16).replace('T', ' ')} ～ ${rounds.at(-1).at.slice(5, 16).replace('T', ' ')} UTC，按时间先后）。`;
  const full = rounds.map(r => r.body);
  const brief = rounds.map(r => r.body.split('\n').filter(l => /^自动续办第|^阶段进度|^完整结论在 Git/.test(l)).join('\n'));
  const parts = [...full];
  for (let i = 0; i < parts.length - 1 && [head, ...parts].join('\n\n---\n\n').length > DIGEST_LIMIT; i++) parts[i] = brief[i];
  let body = [head, ...parts].join('\n\n---\n\n');
  if (body.length > DIGEST_LIMIT) body = `${body.slice(0, DIGEST_LIMIT)}\n\n……（过长已截断，全文见仓库链接）`;
  return body;
}

// One settled round of an automatically continued task. The next round starts at once, so this is the only
// place its result reaches Linear (before 2026-11-22 these were dropped: LON-160 showed round 1 of 17 only).
export function roundReportBody(task, outcome, round, mapping, secrets) {
  let body = `自动续办第 ${round} 轮已结束，下一轮已自动开始；以下是本轮结果（执行者报告，非独立验收）。`;
  if (outcome.workItems) body += `\n阶段进度：${outcome.workItems.filter(i => i.status === 'done').length}/${outcome.workItems.length} 完成。`;
  if (shareable(outcome.publicSummary, secrets)) body += `\n\n${summaryText(outcome.publicSummary)}`;
  else body += outcome.publicSummary ? '\n\n结论摘要含疑似本地路径或凭据，未公开。' : '\n\n执行者本轮没有附结论摘要。';
  const pointer = repoPointer(task);
  if (pointer) body += `\n${pointer}`;
  if (shareable(outcome.next, secrets)) body += `\n\n下一轮：${outcome.next.slice(0, 600)}`;
  return body;
}

// Conservative accidental-disclosure guard, not a general-purpose DLP system.
export function shareable(text, secrets = []) {
  if (!text || secrets.some(s => s && text.includes(s))) return false;
  // A drive letter must not follow another letter: "https://" contains "s:/" and is not a local path
  // (that false positive silently dropped every summary carrying a commit link, LON-33..64, 2026-11-18).
  return !/(?:(?<![A-Za-z])[A-Za-z]:[\\/]|\\\\|\/(?:Users|home|tmp|var|etc|mnt)\/|(?:lin_api_|sk-|ghp_|github_pat_|Bearer\s)[\w-]+|-----BEGIN .*PRIVATE KEY|(?:password|api[_ -]?key|token|secret)\s*[:=]\s*\S+)/i.test(text);
}

export function reportBody(task, mapping, secrets) {
  let body = outcomeReports[task.status] || '本地已收到新的条件变化，正在排队重新核对；这不代表已获得执行授权。';
  const attention = attentionFor(task, { tasks: [task], settings: { projects: [] } });
  if (attention) body += `\n\n下一责任：${attention.owner}。${attention.reason}。${attention.action}`;
  if (task.workItems) body += `\n阶段进度（执行者报告，非独立验收）：${task.workItems.filter(i => i.status === 'done').length}/${task.workItems.length} 完成。`;
  if (task.reviewLimitNotified) body += `\n\n评论自动续办已达上限，自动审核轮次（${task.reviewAudits || 0} 次）也已用完：之后的新评论不会再自动执行。需要接收方本地负责人在派发面板手动继续，或调高唤醒上限 / 审核次数。`;
  const pointer = mapping?.shareProgress && task.outcome ? repoPointer(task) : '';
  if (mapping?.shareProgress && shareable(task.outcome?.publicSummary, secrets))
    body += `\n\n${summaryText(task.outcome.publicSummary)}`;
  // Never leave collaborators with a bare "done" or "blocked": say why the conclusion is not here and where it is.
  else if (mapping?.shareProgress && task.outcome)
    body += (task.outcome.publicSummary ? '\n\n结论摘要含疑似本地路径或凭据，未公开' : '\n\n执行者本轮没有附结论摘要')
      + (pointer ? '。' : '；结论见仓库本单目录的 report.md。');
  if (pointer) body += `\n${pointer}`;
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
