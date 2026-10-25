export function formatTime(value) {
  if (!value) return '未设置';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '时间格式无效' : new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    timeZoneName: 'short'
  }).format(date);
}

export function waitDraftFor(task) {
  const wait = task.wait || {}, kind = wait.kind || 'linear';
  const issueId = wait.issueId || (kind !== 'task' ? task.issue?.id : undefined);
  return { kind, condition: wait.condition || '', ...(issueId ? { issueId } : {}),
    ...(kind === 'task' && wait.taskId ? { taskId: wait.taskId } : {}),
    ...(kind === 'linear' ? { expectedAuthorIds: wait.expectedAuthorIds || [] } : {}),
    ...(wait.notBefore ? { notBefore: wait.notBefore } : {}), ...(wait.expiresAt ? { expiresAt: wait.expiresAt } : {}) };
}

export function waitView(task, data, now = Date.now()) {
  if (!['blocked', 'decision', 'stalled', 'stopped'].includes(task.status) || (task.status === 'stopped' && !task.wait)) return null;
  const wait = task.wait;
  const project = data.settings.projects.find(p => p.id === task.projectId);
  const sync = data.syncStatus?.find(s => s.key === JSON.stringify([project?.linear?.workspaceId, project?.linear?.tokenEnv]));
  // A newly armed wait can still carry the previous round's result. Do not present its blockers as current.
  const prior = task.outcome?.wait;
  const sameWait = !wait || (prior && ['kind', 'condition', 'notBefore', 'expiresAt'].every(k => prior[k] === wait[k]) &&
    (prior.issueId || task.issue?.id) === (wait.issueId || task.issue?.id));
  const blockers = sameWait ? task.outcome?.blockers || [] : [];
  const dependency = wait?.kind === 'task' ? data.tasks.find(t => t.id === wait.taskId) : null;
  const targetId = wait?.issueId || task.issue?.id;
  const context = data.issueContexts?.[task.id];
  const target = dependency?.issue || (targetId && context?.target?.id === targetId ? context.target : data.tasks.find(t => t.issue?.id === targetId)?.issue);
  const targetLabel = target?.identifier || (targetId === task.issue?.id ? task.issue?.identifier : null) || '关联工单（名称未同步）';
  const targetUrl = target?.url?.startsWith('https://linear.app/') ? target.url : null;
  const name = user => user?.name || user?.displayName;
  const replyUsers = context?.replyUsers || [];
  const expected = replyUsers.filter(u => u.id !== project?.linear?.assigneeId && wait?.expectedAuthorIds?.includes(u.id));
  const replyNames = expected.map(name).filter(Boolean).join('、');
  const targetAssignee = name(context?.target?.assignee);
  const sourceAssignee = name(context?.source?.assignee);
  const expired = wait && (wait.status === 'expired' || (wait.expiresAt && Date.parse(wait.expiresAt) <= now));
  let title = wait?.kind === 'task' ? `等待本机任务 ${dependency?.issue?.identifier || dependency?.title || '（目标待核对）'} 完成` : wait?.kind === 'time' ? '等待约定时间' : wait?.kind === 'linear' ? (replyNames ? `等待 ${replyNames} 回复` : '等待 Linear 回复') : '等待条件补充';
  let monitor = '', action = '';
  if (task.historical || task.supersededBy || wait?.status === 'superseded') { title = '历史记录 · 已由续办替代'; monitor = '不再监听或回写'; action = '打开当前任务查看实际进度。'; }
  else if (wait && ['resolved', 'suspended'].includes(wait.status)) { title = '历史等待已结束'; monitor = '监听已停止'; action = '此记录不再自动恢复。'; }
  else if (task.status === 'decision') { title = '需要你做决定'; monitor = '等待决策，不会自动执行'; action = '核对所需决策或授权后，再明确安排继续。'; }
  else if (task.status === 'stalled') { title = '续办已暂停'; monitor = '不会自动执行'; action = '需核对进展或次数限制，再设置恢复条件。'; }
  else if (task.status === 'stopped') { title = '任务已停止'; monitor = '监听已停止'; action = '需明确重新设置恢复条件才会继续监听。'; }
  else if (!wait) { monitor = '未设置自动恢复条件'; action = '需设置恢复条件，或核对阻塞后手动继续。'; }
  else if (wait.status === 'invalid') { title = '等待配置需要修正'; monitor = '配置错误，已停止重试'; action = '本地负责人需按下方原因修正依赖、回复人或执行约束，再重新保存恢复条件；重复评论不会解除。'; }
  else if (wait.status === 'limit') { title = '自动唤醒次数已用完'; monitor = '不会自动执行'; action = '需核对进展和唤醒限制后重新安排。'; }
  else if (expired) { title = '等待窗口已过期'; monitor = project?.followup?.observeAfterExpiry && !data.paused && project?.followup?.enabled ? '仅观察新回复，不会启动执行' : '不会自动执行'; action = '需重新确定有效时间并设置恢复条件。'; }
  else if (task.owner === 'human') { monitor = '人工接管中，自动恢复暂停'; action = '结束人工处理并归还控制后才能恢复监听。'; }
  else if (data.paused) { monitor = '派发已暂停'; action = '开启派发后才会检查条件。'; }
  else if (!project?.followup?.enabled || (task.issue && !project?.linear?.enabled)) { monitor = '项目自动恢复未启用'; action = '在项目配置中启用自动恢复及 Linear 连接。'; }
  else if (wait.error) { monitor = '条件检查失败，正在重试'; action = '条件尚未确认，不会因此启动执行。'; }
  else if (wait.status === 'validating') { monitor = '正在校验等待目标'; action = '确认工单关系与本地规则后才开始监听。'; }
  else if (wait.status === 'watching') {
    const stale = sync?.nextAt ? now > sync.nextAt + 90000 : wait.lastCheckedAt && now - Date.parse(wait.lastCheckedAt) > 90000;
    monitor = sync?.error ? '连接异常，退避重试中' : stale ? '检查记录超过 90 秒未更新' : '自动检查已开启';
    action = stale ? '请核对宿主和连接状态，旧记录不能证明监听在线。' : wait.kind === 'task'
      ? '由本机调度器检查依赖任务的持久完成回执；不需要本人或协作者转发评论，完成后由原会话复核。' : wait.kind === 'time'
      ? '到约定时间后，由原会话重新核验条件；通过后才继续。'
      : `由宿主增量同步可信回复；${sync?.nextAt ? `下次检查 ${formatTime(sync.nextAt)}，` : ''}收到后由原会话核验并继续。`;
  } else { monitor = ({ triggered: '已触发，等待原会话核验', suspended: '监听已停止', resolved: '本轮等待已结束', superseded: '已由后续处理替代' })[wait.status] || '等待状态待核对'; action = '核对当前任务状态后再安排后续处理。'; }
  if (task.attention && !task.historical) action = task.attention.action;
  return { title, monitor, action, blockers, targetId, targetLabel, targetUrl, targetAssignee, sourceAssignee,
    targetTitle: dependency?.title || context?.target?.title,
    dependencyStatus: dependency?.status,
    identityStatus: task.issue && wait?.kind === 'linear' ? context?.status || 'unloaded' : null,
    assignmentMismatch: Boolean(wait?.kind === 'linear' && context?.target?.assignee && expected.length && !expected.some(u => u.id === context.target.assignee.id)),
    reason: task.historical || task.supersededBy ? '本轮已被替代，请查看当前任务。' : task.attention?.reason || blockers.map(b => b.reason).filter(Boolean).join('；') || wait?.condition || '尚未记录具体阻塞原因，需补充后才能安排恢复。',
    owners: wait?.kind === 'linear' ? replyNames || 'Linear 回复者待核对' : [...new Set(blockers.map(b => b.owner).filter(Boolean))].join('、'),
    condition: wait?.condition, next: sameWait ? task.outcome?.next : null, wait };
}
