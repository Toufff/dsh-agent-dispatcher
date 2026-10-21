import React, { useEffect, useState } from 'react';
import { AgentIcon } from './agent-icon.jsx';
const labels = { queued: '排队中', starting: '正在启动', running: '执行中', waiting: '等待输入', busy: '会话忙碌', unknown: '状态待核对', review: '待验收', failed: '执行失败', exhausted: '无可用执行器', stopped: '已停止', stopping: '正在停止', manual: '人工接管', accepted: '已验收' };
const terminal = ['failed', 'exhausted', 'stopped', 'review', 'accepted'];
export function Panel({ api }) {
  const [data, setData] = useState(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState(null), [revision, setRevision] = useState(0), [selected, select] = useState(null);
  const [showConfig, config] = useState(false), [drag, setDrag] = useState(null), [raw, setRaw] = useState('');
  const [newTask, setTask] = useState({ projectId: '', title: '', prompt: '' });
  const [confirmedIdle, setConfirmedIdle] = useState(false);
  useEffect(() => { let live = true; const refresh = () => api.snapshot().then(v => { if (live) setData(v); }).catch(e => { if (live) setError(e.message); });
    refresh(); const timer = setInterval(refresh, 2500); return () => { live = false; clearInterval(timer); }; }, [api]);
  async function run(request) { setBusy(true); setError(''); try { setData(await api.command(request)); return true; }
    catch (e) { setError(e.message); return false; } finally { setBusy(false); } }
  if (!data) return <main className="dispatch"><h1>任务派发</h1><p role="status">{error || '正在读取本机调度状态…'}</p></main>;
  const settings = draft || data.settings, task = data.tasks.find(t => t.id === selected) || data.tasks.at(-1);
  function edit(value) { if (!draft) setRevision(data.revision); setDraft(value); }
  function reorder(from, to) { if (from === null || to < 0 || to >= settings.executors.length) return;
    const executors = [...settings.executors]; executors.splice(to, 0, ...executors.splice(from, 1)); edit({ ...settings, executors }); }
  function openConfig() { config(true); setRaw(JSON.stringify(settings, null, 2)); }
  return <main className="dispatch">
    <header><div><h1>任务派发</h1><p>本机接单，按顺序执行。完成后由你验收。</p></div><div className="actions">
      <span className={`status ${data.paused ? 'waiting' : 'running'}`}>{data.paused ? '自动派发已暂停' : '自动派发已开启'}</span>
      <button disabled={busy} onClick={() => run({ action: data.paused ? 'resume' : 'pause' })}>{data.paused ? '开启派发' : '暂停派发'}</button>
      <button onClick={openConfig}>配置项目与连接</button></div></header>
    {(error || data.errors?.length > 0) && <div className="notice" role="alert">{error || data.errors.join('；')}<button onClick={() => run({ action: 'reconcile' })} disabled={busy}>重新核对</button></div>}
    <div className="dispatch-grid"><aside><h2>执行优先级</h2><p className="muted">拖动调整顺位，或使用上下移按钮。只在明确未启动时尝试下一位。</p>
      <ol className="executors">{settings.executors.map((executor, index) => <li key={executor.id} draggable={!busy} onDragStart={() => setDrag(index)} onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); reorder(drag, index); setDrag(null); }}>
        <span className="rank">{index + 1}</span><div className="executor-info"><strong className="agent-name"><AgentIcon type={executor.type}/>{executor.label}</strong><span className="muted">{executor.type === 'claude' && !executor.verified ? '尚未在此配置验证' : !data.health[executor.id] ? '尚未检查' : data.health[executor.id].available ? '适配器可用' : '适配器不可用，请检查配置'}</span></div>
        <label className="toggle"><input aria-label={`启用 ${executor.label}`} type="checkbox" checked={executor.enabled} onChange={e => edit({ ...settings, executors: settings.executors.map(x => x.id === executor.id ? { ...x, enabled: e.target.checked } : x) })}/>启用</label>
        <div className="rank-controls"><button aria-label={`上移 ${executor.label}`} disabled={index === 0 || busy} onClick={() => reorder(index, index - 1)}>上移</button><button aria-label={`下移 ${executor.label}`} disabled={index === settings.executors.length - 1 || busy} onClick={() => reorder(index, index + 1)}>下移</button></div></li>)}</ol>
      {draft && <div className="actions"><button className="primary" disabled={busy} onClick={async () => { if (await run({ action: 'configure', settings: draft, revision })) setDraft(null); }}>保存顺序</button><button onClick={() => setDraft(null)}>撤销调整</button></div>}
      <p className="muted">新顺序用于后续入队任务。已入队任务保留原顺序。</p><h2>本地任务</h2>
      <form onSubmit={async e => { e.preventDefault(); if (await run({ action: 'submit', ...newTask })) setTask({ ...newTask, title: '', prompt: '' }); }}>
        <label>项目<select required value={newTask.projectId} onChange={e => setTask({ ...newTask, projectId: e.target.value })}><option value="">选择本地项目</option>{data.settings.projects.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}</select></label>
        <label>任务标题<input required maxLength={300} value={newTask.title} onChange={e => setTask({ ...newTask, title: e.target.value })}/></label>
        <label>需求与验收条件<textarea required rows={4} value={newTask.prompt} onChange={e => setTask({ ...newTask, prompt: e.target.value })}/></label><button className="primary" disabled={busy || !data.settings.projects.length}>加入队列</button></form>
    </aside><section className="queue"><div className="section-heading"><h2>任务队列 <span className="count">{data.tasks.length}</span></h2><button disabled={busy} onClick={() => run({ action: 'poll' })}>检查 Linear</button></div>
      {!data.tasks.length ? <div className="empty"><h3>还没有待处理任务</h3><p>先配置本地项目，再添加任务或启用 Linear 接单。</p><button onClick={openConfig}>配置本地项目</button></div>
        : <ul className="task-list">{data.tasks.map(t => <li key={t.id}><button className={task?.id === t.id ? 'selected' : ''} onClick={() => select(t.id)}><strong>{t.title}</strong><span className={`status ${t.status}`}>{labels[t.status] || t.status}</span></button></li>)}</ul>}
      {task && <article className="detail"><h2>{task.title}</h2><p className="muted">{task.owner === 'human' ? '由你控制会话，自动派发暂停等待归还。' : '由调度器控制本轮执行。'}</p><div className="actions">
        <button disabled={busy || terminal.includes(task.status) || task.owner === 'human'} onClick={() => run({ action: 'stop', id: task.id })}>停止任务</button>
        <button disabled={busy || task.owner === 'human'} onClick={() => run({ action: 'takeover', id: task.id })}>人工接管</button>
        {task.owner === 'human' && <><label><input type="checkbox" checked={confirmedIdle} onChange={e => setConfirmedIdle(e.target.checked)}/>我已结束人工会话，确认可继续派发</label><button disabled={busy || !confirmedIdle} onClick={async () => { if (await run({ action: 'return', id: task.id, confirmedIdle })) setConfirmedIdle(false); }}>归还控制</button></>}
        {['failed', 'exhausted', 'stopped'].includes(task.status) && <button disabled={busy} onClick={() => run({ action: 'retry', id: task.id })}>重试任务</button>}
        {task.status === 'review' && <button className="primary" disabled={busy} onClick={() => run({ action: 'accept', id: task.id })}>本地确认验收</button>}
        {task.issue?.url?.startsWith('https://linear.app/') && <a href={task.issue.url} target="_blank" rel="noreferrer">打开 Linear issue</a>}</div>
        <h3>执行记录</h3>{!task.attempts.length && <p className="muted">尚未派发。</p>}{task.attempts.map(a => <div className="attempt" key={a.id}><strong className="agent-name"><AgentIcon type={data.settings.executors.find(e => e.id === a.executor)?.type}/>{data.settings.executors.find(e => e.id === a.executor)?.label || a.executor}</strong><span className={`status ${a.status}`}>{labels[a.status] || a.status}</span>{a.reason && <p>{a.reason}</p>}{a.sessionId && <><code>{a.sessionId}</code>{data.settings.executors.find(e => e.id === a.executor)?.type === 'dsh' ? <button onClick={() => api.openSession(a.sessionId)}>打开 DSH 会话</button> : <p className="muted">在对应工具中使用此会话 ID 恢复；查看会话不自动接管。</p>}</>}</div>)}
        <h3>结果与验收</h3><pre>{task.summary || '等待 agent 返回执行结果。'}</pre><p className="muted">Linear 回写：{task.issue ? ({ pending: '待生成', queued: '等待发送或重试', sent: '已发送' })[task.report] : '本地任务，无需回写'}</p>
        <details><summary>历史与操作记录</summary>{(task.previousAttempts || []).map(a => <p key={a.id}>{a.executor} · {labels[a.status] || a.status} · {a.sessionId}</p>)}{task.events?.map((event, i) => <p key={i}><time>{new Date(event.at).toLocaleString()}</time> · {labels[event.action] || event.action}</p>)}</details></article>}
    </section></div>
    {showConfig && <section className="configuration"><h2>本机项目与连接配置</h2><p>填写本地目录、执行器命令和 Linear 标识。tokenEnv 只填写环境变量名，密钥不应填写在这里。</p>
      <details><summary>新增项目格式</summary><pre>{JSON.stringify({ id: 'my-project', label: '我的项目', cwd: '/absolute/project/path' }, null, 2)}</pre><p>可选 linear 字段：workspaceId、projectId、assigneeId、readyStateId、reviewStateId、tokenEnv、enabled、since（ISO 时间）、round。since 限制首次接单范围。</p></details>
      <label>本机配置 JSON<textarea aria-label="本机配置 JSON" rows={16} spellCheck={false} value={raw} onChange={e => setRaw(e.target.value)}/></label><div className="actions"><button className="primary" disabled={busy} onClick={async () => { try { if (await run({ action: 'configure', settings: JSON.parse(raw), revision: data.revision })) { setDraft(null); config(false); } } catch { setError('JSON 格式有误，请检查逗号和引号。'); } }}>保存配置</button><button onClick={() => config(false)}>关闭配置</button></div></section>}
  </main>;
}
