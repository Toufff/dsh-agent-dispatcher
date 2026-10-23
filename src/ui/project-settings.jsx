import React, { useEffect, useRef, useState } from 'react';

const emptyProject = () => ({ id: `local-${crypto.randomUUID().slice(0, 8)}`, label: '', cwd: '' });
const newMapping = () => ({ tokenEnv: 'LINEAR_API_KEY', workspaceId: '', projectId: '', assigneeId: '', readyStateId: '', reviewStateId: '', enabled: false, since: new Date().toISOString(), round: '1' });
const blankFollowup = () => ({ enabled: false, commentAuthorIds: [], maxWakeups: 8 });

function Choice({ label, value, options, onChange, required = false, disabled = false }) {
  return <label>{label}<select aria-label={label} value={value || ''} required={required} disabled={disabled} onChange={e => onChange(e.target.value)}>
    <option value="">请选择</option>
    {value && !options.some(o => o.id === value) && <option value={value}>已保存：{value}</option>}
    {options.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
  </select></label>;
}

export function ProjectSettings({ data, api, onSave, onClose, onGuardChange }) {
  const [settings, setSettings] = useState(() => structuredClone(data.settings));
  const [baseRevision, setBaseRevision] = useState(data.revision);
  const [selected, setSelected] = useState(data.settings.projects[0]?.id || '');
  const [dirty, setDirty] = useState(false), [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(''), [error, setError] = useState('');
  const [catalogs, setCatalogs] = useState({}), [query, setQuery] = useState('');
  const [checkedPath, setCheckedPath] = useState(''), [raw, setRaw] = useState(null);
  const request = useRef(0);
  useEffect(() => { onGuardChange?.({ dirty, busy }); }, [dirty, busy, onGuardChange]);
  useEffect(() => {
    if (!dirty) return;
    const warn = event => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  const project = settings.projects.find(p => p.id === selected);
  const mapping = project?.linear;
  const catalog = catalogs[mapping?.tokenEnv];
  const validCatalog = catalog && (!mapping?.workspaceId || mapping.workspaceId === catalog.organization.id) ? catalog : null;
  const stale = data.revision !== baseRevision;
  const update = value => { setSettings(value); setDirty(true); setError(''); setNotice(''); };
  const change = patch => update({ ...settings, projects: settings.projects.map(p => p.id === selected ? { ...p, ...patch } : p) });
  const linear = patch => change({ linear: { ...mapping, ...patch } });
  const followup = patch => change({ followup: { ...(project.followup || blankFollowup()), ...patch } });
  function reload() { request.current++; setSettings(structuredClone(data.settings)); setBaseRevision(data.revision); setDirty(false); setRaw(null); setCheckedPath(''); setError(''); setNotice('已重新读取本机配置。'); }
  async function connect() {
    const tokenEnv = mapping.tokenEnv, workspace = mapping.workspaceId, serial = ++request.current;
    setBusy(true); setError(''); setNotice('');
    try {
      const value = await api.catalog(tokenEnv);
      if (serial !== request.current) return;
      if (workspace && workspace !== value.organization.id) throw new Error('此凭据属于另一个 Linear 工作区，未更改当前映射。请使用原连接，或新建项目映射。');
      setCatalogs(old => ({ ...old, [tokenEnv]: value }));
      if (!workspace) linear({ workspaceId: value.organization.id, assigneeId: value.viewer.id });
      setNotice(`已读取 ${value.organization.name} 的 ${value.projects.length} 个项目；不会因此开启接单。`);
    } catch (e) { if (serial === request.current) { setCatalogs(old => { const next = { ...old }; delete next[tokenEnv]; return next; }); setError(e.message); } }
    finally { if (serial === request.current) setBusy(false); }
  }
  async function checkDirectory() {
    setBusy(true); setError(''); const cwd = project.cwd;
    try { await api.checkDirectory(cwd); setCheckedPath(cwd); setNotice('目录存在，宿主可以读取目录信息。未创建或修改文件。'); }
    catch (e) { setCheckedPath(''); setError(e.message); }
    finally { setBusy(false); }
  }
  async function save(e) {
    e.preventDefault(); setBusy(true); setError(''); setNotice('');
    try {
      if (settings.projects.some(p => !p.label.trim() || !p.cwd.trim())) throw new Error('请补齐所有新增项目的名称和目录，或撤销未完成的映射。');
      for (const p of settings.projects) {
        const old = data.settings.projects.find(x => x.id === p.id);
        if (p.cwd !== old?.cwd) await api.checkDirectory(p.cwd);
        if (p.linear && (!p.linear.workspaceId || !p.linear.projectId || !p.linear.assigneeId || !p.linear.readyStateId || !p.linear.reviewStateId))
          throw new Error(`${p.label}：请读取 Linear 连接，并选择项目、负责人和接单／验收状态。`);
        if (p.followup?.enabled && (!p.linear || !p.followup.commentAuthorIds.length))
          throw new Error(`${p.label}：自动恢复需要配置 Linear，并选择至少一位可信回复者。`);
      }
      const saved = await onSave(settings, baseRevision);
      if (saved) { setSettings(structuredClone(saved.settings)); setBaseRevision(saved.revision); setDirty(false); setNotice('配置已保存。已有任务保留原目录和会话；等待任务的恢复条件需要单独核对。'); }
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }
  const states = (validCatalog?.workflowStates || []).map(s => ({ ...s, name: `${s.team.name} / ${s.name}` }));
  return <section className="project-settings" aria-label="项目与连接配置">
    <div className="section-heading"><div><h2>项目与连接</h2><p className="muted">选择 Linear 项目，指定本机工作目录。凭据、目录与执行策略只保存在本机。</p></div><button disabled={busy} onClick={onClose}>返回任务队列</button></div>
    {stale && <div className="notice" role="alert">其他窗口已修改配置。当前草稿保留，重新读取后再保存。<button disabled={busy} onClick={() => { if (!dirty || window.confirm('放弃草稿并读取最新配置？')) reload(); }}>重新读取</button></div>}
    {error && <p className="form-error" role="alert">{error}</p>}{notice && <p className="form-feedback" role="status">{notice}</p>}
    <div className="project-layout"><aside className="project-picker"><label>本机项目<input type="search" placeholder="按名称筛选" value={query} onChange={e => setQuery(e.target.value)}/></label>
      <ul>{settings.projects.filter(p => `${p.label} ${p.id}`.toLowerCase().includes(query.toLowerCase())).map(p => <li key={p.id}><button disabled={busy} aria-pressed={selected === p.id} onClick={() => { setSelected(p.id); setError(''); setNotice(''); setCheckedPath(''); }}><strong>{p.label || '未命名项目'}</strong><span className="muted">{p.linear ? (p.linear.enabled ? 'Linear 接单已启用' : 'Linear 接单已停用') : '仅本地任务'}</span></button></li>)}</ul>
      <button disabled={busy} onClick={() => { const p = emptyProject(); update({ ...settings, projects: [...settings.projects, p] }); setSelected(p.id); setQuery(''); setCheckedPath(''); }}>新增项目映射</button>
      <p className="muted">同一账号的多个项目可以复用相同的密钥环境变量。</p>
    </aside>
    {project ? <form className="project-editor" onSubmit={save}><fieldset disabled={busy}>
      <div className="section-heading"><h2>{project.label || '新增项目'}</h2><span className="status">{dirty ? '有未保存的修改' : '已保存'}</span></div>
      <label>本机项目名称<input required maxLength={160} value={project.label} onChange={e => change({ label: e.target.value })}/></label>
      <label>本地工作目录<input required placeholder="例如 F:/Projects/my-project" value={project.cwd} onChange={e => { change({ cwd: e.target.value }); setCheckedPath(''); }}/></label>
      <div className="actions"><button type="button" onClick={checkDirectory}>检查目录</button><span className="muted">{checkedPath === project.cwd && checkedPath ? '目录存在' : '填写绝对路径；不会自动创建目录。'}</span></div>
      <section className="config-section"><h3>Linear 连接</h3><label className="check-row"><input type="checkbox" checked={!!mapping} onChange={e => { if (e.target.checked) change({ linear: newMapping() }); else { const next = { ...project }; delete next.linear; if (next.followup) next.followup = { ...next.followup, enabled: false }; update({ ...settings, projects: settings.projects.map(p => p.id === selected ? next : p) }); } }}/>为此项目配置 Linear</label>
      {mapping && <><div className="inline-field"><label>密钥环境变量名<input autoComplete="off" value={mapping.tokenEnv} onChange={e => linear({ tokenEnv: e.target.value })} placeholder="LINEAR_API_KEY" pattern="[A-Z][A-Z0-9_]+"/></label><button type="button" onClick={connect}>{busy ? '正在读取…' : '读取账号与项目'}</button></div><p className="muted">连接方式：API Key。这里只填写宿主已配置的变量名，不填写或展示密钥。</p>
        {validCatalog ? <div className="connection-identity"><strong>{validCatalog.viewer.name}</strong><span>{validCatalog.organization.name}</span><span className="status">已验证连接</span></div> : <p className="muted">读取后按真实名称选择项目、成员和状态。现有配置在读取成功前保持不变。</p>}
        <Choice label="Linear 项目" value={mapping.projectId} options={validCatalog?.projects || []} onChange={projectId => { const next = { ...mapping, projectId, readyStateId: '', reviewStateId: '' }; delete next.activeStateId; delete next.blockedStateId; change({ linear: next }); }} required/>
        <div className="config-columns"><Choice label="接收指派给谁的工单" value={mapping.assigneeId} options={validCatalog?.users || []} onChange={assigneeId => linear({ assigneeId })} required/>
        <Choice label="接单状态" value={mapping.readyStateId} options={states} onChange={readyStateId => linear({ readyStateId })} required/>
        <Choice label="完成后的待验收状态" value={mapping.reviewStateId} options={states} onChange={reviewStateId => linear({ reviewStateId })} required/>
        <label>接单起点（ISO 时间）<input required value={mapping.since} onChange={e => linear({ since: e.target.value })}/></label></div>
        <label className="check-row"><input type="checkbox" checked={mapping.enabled} onChange={e => linear({ enabled: e.target.checked })}/>启用此项目的 Linear 接单</label>
        <label className="check-row"><input type="checkbox" checked={!!mapping.shareProgress} onChange={e => linear({ shareProgress: e.target.checked })}/>向 Linear 同步可分享的进展摘要</label>
        <details><summary>更多状态映射</summary><div className="config-columns"><Choice label="执行中状态（可选）" value={mapping.activeStateId} options={states} onChange={activeStateId => { const next = { ...mapping }; if (activeStateId) next.activeStateId = activeStateId; else delete next.activeStateId; change({ linear: next }); }}/><Choice label="阻塞状态（可选）" value={mapping.blockedStateId} options={states} onChange={blockedStateId => { const next = { ...mapping }; if (blockedStateId) next.blockedStateId = blockedStateId; else delete next.blockedStateId; change({ linear: next }); }}/></div></details>
      </>}</section>
      <details className="config-section" key={project.id}><summary>外部回复与自动恢复 · {project.followup?.enabled ? '已启用' : '未启用'}</summary><label className="check-row"><input type="checkbox" disabled={!mapping} checked={!!project.followup?.enabled} onChange={e => followup({ enabled: e.target.checked })}/>监听可信回复，并在条件变化后核验是否续办</label>
        <p className="muted">回复是核验线索，不是额外授权。项目配置不会自动重开历史任务。</p>
        {(mapping || project.followup) && <><fieldset className="reply-members"><legend>可信回复者（可多选）</legend>{[...(validCatalog?.users || []), ...(project.followup?.commentAuthorIds || []).filter(id => !validCatalog?.users.some(u => u.id === id)).map(id => ({ id, name: `已保存：${id}` }))].map(u => <label className="check-row" key={u.id}><input type="checkbox" checked={project.followup?.commentAuthorIds?.includes(u.id) || false} onChange={e => followup({ commentAuthorIds: e.target.checked ? [...(project.followup?.commentAuthorIds || []), u.id] : (project.followup?.commentAuthorIds || []).filter(id => id !== u.id) })}/>{u.name}</label>)}</fieldset><p className="muted">先读取 Linear 连接，再勾选允许唤醒此项目的成员。</p><label className="check-row"><input type="checkbox" checked={!!project.followup?.observeAfterExpiry} onChange={e => followup({ observeAfterExpiry: e.target.checked })}/>窗口过期后仅收集回复，不启动执行</label></>}
      </details>
      <details className="config-section"><summary>项目执行约束</summary><label>每轮执行都附带的本地约束<textarea rows={4} value={project.executionInstructions || ''} onChange={e => change({ executionInstructions: e.target.value })}/></label></details>
      <div className="config-save"><p className="muted">保存所有项目草稿。正在执行的项目不允许改目录；后台会再次检查。</p><div className="actions"><button className="primary" disabled={!dirty || stale} type="submit">{busy ? '正在保存…' : '保存配置'}</button><button type="button" disabled={!dirty} onClick={() => { if (window.confirm('撤销本页所有未保存的修改？')) reload(); }}>撤销修改</button></div></div>
    </fieldset></form> : <div className="empty"><h3>还没有本地项目映射</h3><p>先新增项目，再选择 Linear 项目和本机文件夹。</p></div>}</div>
    <details className="advanced-config" onToggle={e => { if (e.currentTarget.open && raw === null) setRaw(JSON.stringify(settings, null, 2)); }}><summary>高级配置 JSON（执行器命令与完整配置）</summary><p className="muted">载入 JSON 只更新草稿，不会立即保存或启动任务。不要填写密钥。</p><label>本机配置 JSON<textarea aria-label="本机配置 JSON" rows={12} value={raw ?? ''} onChange={e => setRaw(e.target.value)} spellCheck={false}/></label><div className="actions"><button disabled={busy} onClick={() => { try { const next = JSON.parse(raw); if (!Array.isArray(next.projects) || !Array.isArray(next.executors) || next.projects.some(p => !p || !['id','label','cwd'].every(k => typeof p[k] === 'string') || (p.linear && !['workspaceId','projectId','assigneeId','readyStateId','reviewStateId','tokenEnv','since'].every(k => typeof p.linear[k] === 'string')) || (p.followup && !Array.isArray(p.followup.commentAuthorIds)))) throw new Error(); update(next); setSelected(next.projects[0]?.id || ''); setNotice('JSON 已载入草稿，请核对并保存。'); } catch { setError('JSON 格式有误，必须包含 projects 和 executors 数组。'); } }}>载入草稿</button><button disabled={busy} onClick={() => setRaw(JSON.stringify(settings, null, 2))}>从当前表单刷新</button>{!project && <button className="primary" disabled={!dirty || busy || stale} onClick={save}>保存配置</button>}</div></details>
  </section>;
}
