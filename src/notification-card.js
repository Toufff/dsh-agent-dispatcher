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
    blocker: type === 'review' ? '' : type === 'preview' ? blockers[0] || '' : (infrastructure ? reason : blockers[0] || reason) || '通知未记录具体原因，请在工单核对当前情况。',
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
  const paragraph = (content, size = 'normal', color = 'default') => ({
    tag: 'div', text: { ...plain(content), text_size: size, text_color: color }, margin: '0px'
  });
  // Only code-owned labels use Markdown. Dynamic values stay literal even in
  // nested containers, so executor output cannot create mentions or controls.
  const section = (label, value) => value ? [
    { tag: 'markdown', content: `**${label}**`, text_size: 'normal', margin: '0px' }, paragraph(value)
  ] : [];
  const column = (elements, background = 'default') => ({
    tag: 'column', width: 'weighted', weight: 1, vertical_align: 'top',
    vertical_spacing: '8px', padding: '12px', background_style: background, elements
  });
  const elements = [];
  if (view.title) elements.push(paragraph(view.title, 'heading'));
  elements.push(paragraph(view.operation, 'notation', 'grey'));
  const columns = [];
  if (view.blocker) columns.push(column(section('当前卡点', view.blocker), `${view.color}-50`));
  columns.push(column(section(type === 'review' ? '验收下一步' : '现在要做什么', view.action), 'blue-50'));
  // Critical text is never collapsed. Feishu stacks these columns on narrow
  // screens instead of squeezing two long instructions into half-width cells.
  elements.push({ tag: 'column_set', flex_mode: 'stretch', horizontal_spacing: '12px', columns });
  if (view.next) elements.push(...section('具体下一步 · 执行者报告', view.next));
  if (view.href) elements.push({
    tag: 'button', text: plain(type === 'decision' ? '前往工单回复' : type === 'review' ? '查看交付并验收' : '打开 Linear 工单'),
    type: 'primary_filled', size: 'medium', width: 'fill',
    behaviors: [{ type: 'open_url', default_url: view.href }]
  });
  // Review recipients need the delivery summary immediately; interrupted work
  // keeps progress and secondary dependencies behind a native disclosure.
  if (type === 'review') elements.push(...section('交付摘要 · 执行者报告', view.progress));
  const details = [
    ...section('已做到哪里 · 执行者报告', type === 'review' ? '' : view.progress),
    ...section('阶段记录 · 待验收', view.stages),
    ...section('满足后可继续', view.resume),
    ...section('其他依赖', view.otherBlockers.join('；')),
    ...section('剩余事项', view.remaining),
    ...section('原通知内容', view.legacy.join('\n'))
  ];
  if (details.length) elements.push({
    tag: 'collapsible_panel', expanded: false,
    header: { title: plain('进展与相关记录'), padding: '10px 12px 10px 12px',
      icon: { tag: 'standard_icon', token: 'down-small-ccm_outlined', color: 'grey', size: '16px 16px' },
      icon_position: 'right', icon_expanded_angle: -180 },
    border: { color: 'grey-200', corner_radius: '8px' },
    padding: '12px 12px 12px 12px', vertical_spacing: '8px', elements: details
  });
  elements.push(paragraph(view.notice, 'notation', 'grey'));
  return {
    schema: '2.0',
    config: { update_multi: true, summary: { content: `${view.heading}｜${view.intervention}｜${view.blocker || view.operation}`.slice(0, 150) } },
    header: { template: view.color, title: plain(view.heading), padding: '16px',
      text_tag_list: [{ tag: 'text_tag', text: plain(view.intervention), color: view.color === 'grey' ? 'neutral' : view.color }] },
    body: { direction: 'vertical', padding: '16px', vertical_spacing: '12px', elements }
  };
}
