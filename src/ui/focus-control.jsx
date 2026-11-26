import React, { useState } from 'react';

const ids = text => text.split(/[\s,，、;；]+/).map(s => s.trim()).filter(Boolean);

/** Compact focus-mode control: on/off with the focus list and intent, held count, and the confirmation queue. */
export function FocusControl({ focus, busy, run }) {
  const [issues, setIssues] = useState(''), [intent, setIntent] = useState('');
  const f = focus || { enabled: false, issues: [], pending: [], held: [] };
  return <details className="local-task focus-control" open={f.enabled && f.pending.length > 0}>
    <summary>{f.enabled ? `聚焦模式：${f.issues.join('、')}（冻结 ${f.held.length}，待确认 ${f.pending.length}）` : '聚焦模式（未开启）'}</summary>
    <p className="muted">开启后只自动启动聚焦单及判定为相关的单；其他单排队冻结，不丢失。相关单保持全部自动续办。</p>
    {f.enabled && f.intent && <p className="muted">意图：{f.intent}</p>}
    <form onSubmit={async e => { e.preventDefault(); const list = ids(issues); if (!list.length) return;
      if (await run(f.enabled ? { action: 'focus-add', issues: list } : { action: 'focus-set', issues: list, intent })) { setIssues(''); setIntent(''); } }}>
      <label>{f.enabled ? '追加聚焦单' : '聚焦单（如 LON-35 LON-160）'}<input value={issues} onChange={e => setIssues(e.target.value)}/></label>
      {!f.enabled && <label>今天要做什么（给判定用）<textarea rows={2} maxLength={2000} value={intent} onChange={e => setIntent(e.target.value)}/></label>}
      <div className="actions"><button className="primary" disabled={busy || !ids(issues).length}>{f.enabled ? '追加' : '开启聚焦'}</button>
        {f.enabled && <button type="button" disabled={busy} onClick={() => run({ action: 'focus-clear' })}>退出聚焦（释放冻结）</button>}</div>
    </form>
    {f.enabled && f.issues.length > 0 && <ul className="focus-issues">{f.issues.map(i => <li key={i}>{i} <button type="button" disabled={busy} onClick={() => run({ action: 'focus-remove', issues: [i] })}>移出</button></li>)}</ul>}
    {f.pending.length > 0 && <><h3>待确认</h3><ul className="focus-pending">{f.pending.map(p => <li key={p.issue}><strong>{p.issue}</strong> {p.verdict === 'error' ? '判定失败' : '无法判断'}：{p.reason}
      <button type="button" disabled={busy} onClick={() => run({ action: 'focus-approve', issue: p.issue })}>算相关</button>
      <button type="button" disabled={busy} onClick={() => run({ action: 'focus-reject', issue: p.issue })}>不相关</button></li>)}</ul></>}
  </details>;
}
