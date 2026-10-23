import React, { useState } from 'react';
import { formatTime } from './wait-view.js';

export function ConnectionStatus({ projects, api, onCatalogs, syncStatus = [] }) {
  const [results, setResults] = useState({}), [busy, setBusy] = useState(false);
  const keys = [...new Set(projects.filter(p => p.linear && (p.category || 'business') === 'business').map(p => p.linear.tokenEnv))];
  async function check() {
    setBusy(true);
    const catalogs = {}, next = {};
    await Promise.all(keys.map(async key => {
      try { const value = await api.catalog(key); catalogs[key] = value;
        const mismatch = projects.some(p => p.linear?.tokenEnv === key && p.linear.workspaceId !== value.organization.id);
        next[key] = { ok: !mismatch, label: `${value.viewer.name} · ${value.organization.name}`, error: mismatch ? '凭据工作区与本地映射不一致，请核对项目配置。' : '', at: new Date().toISOString() };
      } catch (error) { next[key] = { ok: false, error: error.message, at: new Date().toISOString() }; }
    }));
    setResults(next); onCatalogs(catalogs); setBusy(false);
  }
  return <section className="connection-status" aria-label="Linear 连接状态">
    <div className="section-heading"><div><strong>Linear 连接</strong><p className="muted">认证：API Key · 更新方式：增量同步，间隔自动调整 · 无需公网服务</p></div>
      <button disabled={busy || !keys.length} onClick={check}>{busy ? '正在检查连接…' : '检查 Linear 连接'}</button></div>
    {!keys.length ? <p>尚未配置正式项目的 Linear 连接，请在“项目与连接”中添加。</p> : keys.map(key => <p key={key} role="status">{results[key] ? <>{results[key].ok ? `连接正常：${results[key].label}` : `连接检查失败：${results[key].error}`} · {formatTime(results[key].at)}</> : '尚未检查连接；自动派发开启不代表 Linear 连接正常。'}</p>)}
    {syncStatus.map(s => <p key={s.key} role="status">{projects.filter(p => p.linear && JSON.stringify([p.linear.workspaceId,p.linear.tokenEnv]) === s.key).map(p => p.label).join('、')}：{s.error || '同步正常'} · 上次成功 {formatTime(s.lastSuccessAt)} · 下次检查 {formatTime(s.nextAt)}{s.intervalMs && !s.error ? ` · 当前间隔 ${Math.round(s.intervalMs / 1000)} 秒` : ''}</p>)}
    {!syncStatus.length && <p className="muted">尚无同步记录。启用项目接单后由宿主统一同步，关闭页面不影响运行。</p>}
    <p className="muted">此按钮只验证身份与目录读取，不接单、不启动任务；写入权限以实际回写结果为准。</p>
  </section>;
}
