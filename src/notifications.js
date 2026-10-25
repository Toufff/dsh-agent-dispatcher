import { readFile, stat } from 'node:fs/promises';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { attentionFor, currentTask } from './workflow.js';
import { shareable } from './reporting.js';

const reasons = {
  decision: '任务需要你作出决定，请打开工单查看具体问题。',
  failed: '任务执行失败，需要检查失败原因。',
  exhausted: '当前执行器均无法接单，需要检查本机执行器配置。',
  stalled: '自动继续已停止，需要检查下一步。',
  needs_result: '任务结果无法识别，需要检查结果格式。',
  invalid: '恢复条件配置无效，需要修正等待对象或条件。',
  expired: '等待窗口已过期，需要重新安排有效时段。',
  limit: '已达到自动唤醒上限，需要复核任务进展。',
  monitor: '条件监听连续失败，需要检查连接或权限。',
  report: 'Linear 回写连续失败，需要检查连接或权限；任务不会重跑。',
  review: '执行已完成，等待你验收；尚未自动标记为 Done。',
  unrouted: '阻塞未设置恢复条件，需要本地负责人明确下一触发。'
};
const fingerprint = channel => createHash('sha256').update(JSON.stringify(channel)).digest('hex');
const issueLabel = task => /^[A-Z][A-Z0-9]*-\d+$/.test(task.issue?.identifier || '') ? task.issue.identifier : '本地任务';
function issueLink(task) {
  try { const url = new URL(task.issue?.url); return url.protocol === 'https:' && url.hostname === 'linear.app' && !url.username && !url.password && !url.search && !url.hash ? url.href : ''; }
  catch { return ''; }
}

// Validate the whole field BEFORE shortening it. Never fall back to raw transcripts.
function excerpt(value, secrets, limit = 220) {
  if (typeof value !== 'string' || !shareable(value, secrets) || /https?:\/\/|[\w.+-]+@[\w.-]+\.[a-z]{2,}/i.test(value)) return '';
  const clean = value.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim();
  return clean.length > limit ? `${clean.slice(0, limit)}…` : clean;
}

export function notificationText(task, type, secrets = []) {
  const safe = (value, limit) => excerpt(value, secrets, limit);
  const title = safe(task.title, 140).replace(/(?:\s*·\s*续办)+$/, '');
  const outcome = task.outcome || {};
  const lines = [`任务派发通知 · ${issueLabel(task)}`];
  if (title) lines.push(`任务：${title}`);
  const reason = type === 'stalled' ? task.continuationStop === 'budget'
    ? '本轮自动续办次数已用完，任务仍有未完成事项。' : '本轮没有可确认的新进展，自动续办已停止。' : reasons[type];
  lines.push(`当前情况：${reason}`);
  const progress = safe(outcome.publicSummary, 400) || safe(outcome.progress);
  lines.push(progress ? `执行者报告：${progress}` : '进展摘要：本轮未提供可分享的进展，请查看工单核对。');
  if (task.workItems?.length) {
    const count = status => task.workItems.filter(i => i.status === status).length;
    lines.push(`阶段记录（待验收）：${count('done')}/${task.workItems.length} 完成，${count('ready')} 项可继续，${count('blocked') + count('decision')} 项受阻或待决定。`);
  }
  const blockers = (outcome.blockers || []).map(b => ({ owner: safe(b.owner, 60), reason: safe(b.reason), resume: safe(b.resumeWhen) })).filter(b => b.reason).slice(0, 2);
  for (const blocker of blockers) {
    lines.push(`卡点：${blocker.reason}${blocker.owner ? `（责任方：${blocker.owner}）` : ''}`);
    if (blocker.resume) lines.push(`恢复条件：${blocker.resume}`);
  }
  const remaining = (outcome.remaining || []).map(v => safe(v, 120)).filter(Boolean).slice(0, 2);
  if (remaining.length) lines.push(`未完成：${remaining.join('；')}`);
  const next = safe(outcome.next);
  if (next) lines.push(`后续步骤（执行者报告）：${next}`);
  const action = ({
    stalled: '本地负责人核对进展与剩余事项，在派发面板补充本轮要求后继续。',
    unrouted: '本地负责人在派发面板设置恢复条件，或确认可做的下一步后继续。',
    review: '请核对工单中的交付与验证证据，完成验收。',
    report: '本地负责人检查 Linear 连接与权限，恢复回写；不要重跑业务任务。',
    monitor: '本地负责人检查 Linear 连接、权限和等待对象。'
  })[type] || '本地负责人查看工单具体问题，并在派发面板处理该提示。';
  lines.push(`现在需要：${action}`, issueLink(task) || '请在本机任务派发面板查看。', '通知仅作提醒；执行者报告不等于验收，也不会授予新权限。');
  return lines.join('\n');
}

export function attention(state, channel, secrets = []) {
  const found = new Map();
  for (const task of state.tasks.filter(t => currentTask(t, state))) {
    if (!channel.projectIds.includes(task.projectId) || task.wait?.status === 'superseded') continue;
    const types = [];
    if (['decision', 'failed', 'exhausted', 'stalled', 'needs_result'].includes(task.status)) types.push(task.status);
    if (task.status === 'blocked') {
      if (!task.wait && attentionFor(task, state)) types.push('unrouted');
      if (['invalid', 'expired', 'limit'].includes(task.wait?.status)) types.push(task.wait.status);
      else if (task.wait?.errorCount >= 3) types.push('monitor');
    }
    if (state.outbox.some(i => i.taskId === task.id && i.status === 'pending' && i.tries >= 3)) types.push('report');
    if (channel.completed && task.status === 'review') types.push('review');
    for (const type of types) {
      const key = `${task.id}:${type}`;
      found.set(key, { taskId: task.id, type, text: notificationText(task, type, secrets) });
    }
  }
  return found;
}

export async function loadFeishuCredentials(file) {
  try {
    if ((await stat(file)).size > 16384) throw new Error();
    const value = JSON.parse(await readFile(file, 'utf8'));
    const url = new URL(value.webhook);
    if (url.protocol !== 'https:' || url.hostname !== 'open.feishu.cn' || url.port || url.username || url.password || url.search || url.hash ||
        !/^\/open-apis\/bot\/v2\/hook\/[a-zA-Z0-9-]+$/.test(url.pathname)) throw new Error();
    if (value.signingSecret !== undefined && (typeof value.signingSecret !== 'string' || value.signingSecret.length > 2048)) throw new Error();
    return { webhook: url.href, signingSecret: value.signingSecret };
  } catch { throw new Error('飞书凭据文件缺失或格式不正确'); }
}

export async function sendFeishu(channel, text, { fetchImpl = fetch, clock = Date.now } = {}) {
  let credentials;
  try { credentials = await loadFeishuCredentials(channel.credentialsFile); }
  catch { return { status: 'failed', error: '飞书凭据文件缺失或格式不正确' }; }
  // Keep the durable text format compatible with old outbox entries. Only a
  // standalone validated Linear URL becomes a link, never user-supplied markup.
  const [title, ...lines] = text.split('\n');
  const content = (lines.length ? lines : [title]).map(line => {
    const href = issueLink({ issue: { url: line } });
    return [href ? { tag: 'a', text: '查看工单', href } : { tag: 'text', text: line }];
  });
  const body = { msg_type: 'post', content: { post: { zh_cn: { title, content } } } };
  if (credentials.signingSecret) {
    body.timestamp = String(Math.floor(clock() / 1000));
    body.sign = createHmac('sha256', `${body.timestamp}\n${credentials.signingSecret}`).update('').digest('base64');
  }
  try {
    const response = await fetchImpl(credentials.webhook, { method: 'POST', redirect: 'error',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
    if (response.status === 429) {
      const retry = Number(response.headers.get('retry-after'));
      return { status: 'pending', error: '飞书限流，稍后重试', retryMs: Math.min(3600000, Math.max(60000, Number.isFinite(retry) ? retry * 1000 : 60000)) };
    }
    if (!response.ok) return { status: 'failed', error: `飞书 HTTP ${response.status}，请检查通知渠道` };
    const result = await response.json();
    if (result.code === 0 || result.StatusCode === 0 && result.code === undefined) return { status: 'sent' };
    return { status: 'failed', error: '飞书拒绝消息，请检查签名、关键词或 IP 限制' };
  } catch {
    // A timeout can occur after delivery. Never silently duplicate a message.
    return { status: 'unknown', error: '飞书发送结果未知，请先核对群消息；未自动重发' };
  }
}

export class Notifications {
  constructor(runtime, { send = sendFeishu, clock = Date.now } = {}) { this.runtime = runtime; this.send = send; this.clock = clock; }
  run() {
    if (this.pending) return this.pending;
    this.pending = this.flush().finally(() => { this.pending = null; });
    return this.pending;
  }
  async flush() {
    const now = this.clock();
    await this.runtime.dispatcher.update(state => {
      const channels = state.settings.notifications?.channels || [];
      if (!channels.length && !state.notifications) return;
      const data = state.notifications ||= { active: {}, initialized: {}, outbox: [] };
      // An interrupted send has an ambiguous outcome, not a retryable failure.
      for (const entry of data.outbox) if (entry.status === 'sending') {
        entry.status = 'unknown'; entry.error = '宿主在发送期间退出，结果未知；未自动重发';
      }
      const active = {};
      for (const channel of channels.filter(c => c.enabled)) {
        const revision = fingerprint(channel), first = !data.initialized[revision];
        const secrets = Object.values(this.runtime.env || {}).filter(v => typeof v === 'string' && v.length > 12);
        for (const [key, incident] of attention(state, channel, secrets)) {
          const identity = `${revision}:${key}`;
          active[identity] = data.active[identity] || randomUUID();
          if (!data.active[identity] && (!first || channel.includeExisting)) data.outbox.push({
            id: active[identity], channelId: channel.id, revision, ...incident, status: 'pending', tries: 0, createdAt: now
          });
        }
        data.initialized[revision] = true;
      }
      data.active = active;
      for (const item of data.outbox) if (item.status === 'pending' && !Object.values(active).includes(item.id)) item.status = 'superseded';
      // Retain pending deliveries plus bounded history; dedup lives in active.
      data.outbox = [...data.outbox.filter(i => i.status === 'pending'), ...data.outbox.filter(i => i.status !== 'pending').slice(-200)];
      const revisions = channels.map(fingerprint);
      data.initialized = Object.fromEntries(Object.entries(data.initialized).filter(([key]) => revisions.includes(key)));
    });
    let entry, channel;
    await this.runtime.dispatcher.update(state => {
      const data = state.notifications;
      if (!data || now < (data.nextSendAt || 0)) return;
      entry = data.outbox.find(i => i.status === 'pending' && now >= (i.nextAt || 0));
      if (!entry) return;
      channel = state.settings.notifications?.channels.find(c => c.id === entry.channelId && c.enabled && fingerprint(c) === entry.revision);
      if (!channel) { entry.status = 'superseded'; entry = null; return; }
      entry.status = 'sending'; entry.tries++; data.nextSendAt = now + 1000;
      entry = structuredClone(entry); channel = structuredClone(channel);
    });
    if (!entry) return;
    let result;
    try { result = await this.send(channel, entry.text); }
    catch { result = { status: 'unknown', error: '飞书发送结果未知，请先核对群消息；未自动重发' }; }
    await this.runtime.dispatcher.update(state => {
      const item = state.notifications.outbox.find(i => i.id === entry.id);
      if (!item || item.status !== 'sending') return;
      Object.assign(item, result, { updatedAt: this.clock() });
      if (item.status === 'pending') {
        if (item.tries >= 3) { item.status = 'failed'; item.error = '飞书连续限流，已停止重试'; }
        else item.nextAt = this.clock() + (result.retryMs || 60000);
      }
    });
  }
}
