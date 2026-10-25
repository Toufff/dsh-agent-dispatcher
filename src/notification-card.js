// Presentation only: incident detection, delivery dedup and execution stay separate.
const states = {
  // Explicit transport smoke tests only; attention() never emits this type.
  preview: ['blue', '通知样式测试', '无需介入', '仅验证通知显示，不代表业务任务状态'],
  decision: ['orange', '等待决定', '需要你回复', '等待决定，尚未完成'],
  failed: ['red', '执行失败', '需要介入', '本轮执行失败'],
  exhausted: ['red', '无法启动', '需要介入', '没有可接单的执行器'],
  stalled: ['orange', '续办已停止', '需要介入', '自动续办已停止'],
  needs_result: ['orange', '结果待核对', '需要介入', '执行结果尚未确认'],
  invalid: ['orange', '等待配置无效', '需要介入', '无法按当前条件恢复'],
  expired: ['orange', '等待已过期', '需要介入', '等待时段已结束'],
  limit: ['orange', '唤醒已暂停', '需要介入', '自动唤醒次数已用完'],
  monitor: ['red', '监听异常', '需要介入', '条件核验异常；不代表业务执行失败'],
  report: ['red', '回写异常', '需要介入', 'Linear 回写异常；业务任务不会因此重跑'],
  review: ['blue', '执行完成', '请验收', '执行者报告完成，尚未人工验收'],
  unrouted: ['orange', '缺少恢复条件', '需要介入', '任务受阻，未设置自动恢复条件']
};

function linearLink(line) {
  try {
    const url = new URL(line);
    return url.protocol === 'https:' && url.hostname === 'linear.app' && !url.username && !url.password && !url.search && !url.hash ? url.href : '';
  } catch { return ''; }
}

export function notificationPresentation(text, type) {
  const [heading, ...lines] = text.split('\n');
  const read = prefix => lines.find(line => line.startsWith(prefix))?.slice(prefix.length).trim() || '';
  const all = prefix => lines.filter(line => line.startsWith(prefix)).map(line => line.slice(prefix.length).trim());
  const [color, status, intervention, operation] = states[type] || ['grey', '历史通知', '请核对当前状态', '历史快照，不代表当前运行状态'];
  const issue = heading.match(/ · ([A-Z][A-Z0-9]*-\d+|本地任务)$/)?.[1] || '';
  const known = Boolean(states[type]);
  // Transport faults must lead with the transport problem, not an unrelated
  // business blocker carried over from the executor's last outcome.
  const infrastructure = ['monitor', 'report', 'invalid', 'expired', 'limit', 'exhausted', 'needs_result'].includes(type);
  const blockers = all('卡点：');
  const reason = read('当前情况：');
  const next = read('后续步骤（执行者报告）：');
  return {
    color, heading: `${status} · ${issue || '任务派发通知'}`, intervention, operation,
    title: read('任务：'),
    blocker: ['review', 'preview'].includes(type) ? '' : (infrastructure ? reason : blockers[0] || reason) || '通知未记录具体原因，请在工单核对当前情况。',
    action: type === 'decision' && next ? next : read('现在需要：') || '打开工单核对当前状态和下一责任人。',
    // A concrete decision/next step is useful immediately, ahead of progress.
    next: type === 'decision' || type === 'review' || infrastructure ? '' : next,
    resume: type === 'review' || infrastructure ? '' : read('恢复条件：'),
    progress: read('执行者报告：') || read('进展摘要：'),
    stages: read('阶段记录（待验收）：'),
    otherBlockers: infrastructure ? blockers : blockers.slice(1),
    remaining: read('未完成：'),
    href: lines.map(linearLink).find(Boolean) || '',
    legacy: known && reason ? [] : lines.filter(line => !linearLink(line)),
    notice: '任务派发通知 · 发送时状态快照；最新进展以工单为准。报告不等于验收，通知不授予权限。'
  };
}

export function feishuCard(text, type) {
  const view = notificationPresentation(text, type);
  const plain = content => ({ tag: 'plain_text', content });
  const paragraph = content => ({ tag: 'div', text: plain(content) });
  // Only static section labels use Markdown. Every dynamic value is literal
  // plain_text: executor output cannot create links, @mentions or fake buttons.
  const section = (label, value) => value ? [
    { tag: 'div', text: { tag: 'lark_md', content: `**${label}**` } }, paragraph(value)
  ] : [];
  const elements = [paragraph(`${view.intervention}\n${view.operation}`)];
  if (view.title) elements.push(paragraph(view.title));
  elements.push({ tag: 'hr' }, ...section('卡在哪里', view.blocker), ...section('现在要做什么', view.action));
  if (view.next) elements.push(paragraph(`具体下一步（执行者报告）：${view.next}`));
  if (view.resume) elements.push(paragraph(`满足后可继续：${view.resume}`));
  if (view.progress || view.stages) {
    elements.push({ tag: 'hr' }, ...section('已做到哪里 · 执行者报告', view.progress));
    if (view.stages) elements.push(paragraph(`阶段记录（待验收）：${view.stages}`));
  }
  if (view.otherBlockers.length) elements.push(paragraph(`其他依赖：${view.otherBlockers.join('；')}`));
  if (view.remaining) elements.push(paragraph(`剩余事项：${view.remaining}`));
  if (view.legacy.length) elements.push(...section('原通知内容', view.legacy.join('\n')));
  if (view.href) elements.push({ tag: 'action', actions: [{ tag: 'button', text: plain('打开 Linear 工单'), type: 'primary', url: view.href }] });
  elements.push({ tag: 'note', elements: [plain(view.notice)] });
  return { config: { wide_screen_mode: true }, header: { template: view.color, title: plain(view.heading) }, elements };
}
