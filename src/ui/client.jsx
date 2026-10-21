import React from 'react';
import { Panel } from './panel.jsx';
import { remote } from '../remote.js';
import css from './style.css';
export const inject = ['remote', 'slots', 'uiWorkspace'];
export async function apply(ctx) {
  const dispose = await ctx.remote.$mount(remote);
  ctx.effect(() => dispose);
  ctx.effect(() => { const style = document.createElement('style'); style.textContent = css; document.head.append(style); return () => style.remove(); });
  const api = {
    snapshot: async () => unwrap(await ctx.remote.agentDispatcher.snapshot()),
    command: async request => unwrap(await ctx.remote.agentDispatcher.command(request)),
    openSession: id => ctx.uiWorkspace.openSession(id)
  };
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'agent-dispatcher', inject: () => ({ api }) }, Panel));
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: 'agent-dispatcher',
    order: 12, label: () => '任务派发' }, () => <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M4 5h16M4 12h11M4 19h6m8-4 4 4-4 4m4-4H12"/></svg>));
}
function unwrap(result) { if (!result.ok) throw new Error(result.error?.message || '远程操作失败'); return result.value; }
