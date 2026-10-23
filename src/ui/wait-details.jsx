import React from 'react';
import { formatTime } from './wait-view.js';

export function WaitDetails({ view }) {
  const { wait } = view;
  return <section className="wait-detail" aria-label="当前等待">
    <div className="section-heading"><h3>{view.title}</h3><span className="status waiting">{view.monitor}</span></div>
    <p className="wait-reason">{view.reason}</p>
    <dl>
      {view.owners && <><dt>下一步由谁处理</dt><dd>{view.owners}</dd></>}
      {wait?.kind === 'linear' && <><dt>在哪里等回复</dt><dd>{view.targetUrl ? <a href={view.targetUrl} target="_blank" rel="noreferrer">{view.targetLabel}</a> : view.targetLabel}</dd></>}
      {view.condition && <><dt>继续所需条件</dt><dd>{view.condition}</dd></>}
      {view.blockers.map((b, i) => <React.Fragment key={i}><dt>{b.owner || '依赖方'}需满足</dt><dd>{b.resumeWhen}</dd></React.Fragment>)}
      {wait?.notBefore && <><dt>最早恢复检查</dt><dd><time dateTime={wait.notBefore}>{formatTime(wait.notBefore)}</time></dd></>}
      {wait?.expiresAt && <><dt>执行截止</dt><dd><time dateTime={wait.expiresAt}>{formatTime(wait.expiresAt)}</time> · 过期不执行</dd></>}
      <dt>系统接下来做什么</dt><dd>{view.action}</dd>
      {view.next && <><dt>条件满足后的下一步</dt><dd>{view.next}</dd></>}
      {wait && <><dt>最近一次检查</dt><dd>{wait.lastCheckedAt ? formatTime(wait.lastCheckedAt) : '尚未检查'}</dd></>}
    </dl>
    {wait?.error && <p role="alert">检查失败：{wait.error}</p>}
    {wait?.pendingUpdate && <p role="status">{formatTime(wait.pendingUpdate.receivedAt)} 收到新回复，已保留；需确认有效窗口后才能执行。</p>}
    <p className="muted">回复或到点会触发核验，不代表已经满足全部执行条件。</p>
    {wait?.kind === 'linear' && !view.targetUrl && view.targetId && <details><summary>关联工单标识</summary><code>{view.targetId}</code></details>}
  </section>;
}
