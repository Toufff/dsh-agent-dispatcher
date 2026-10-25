// Local layout approximation of the exact outbound payload, not a Feishu screenshot.
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { feishuCard } from '../src/notification-card.js';
import { notificationText } from '../src/notifications.js';

const task = { title: '数据完整性修复 · 审阅分支交付', issue: { identifier: 'DEMO-15', url: 'https://linear.app/example/issue/DEMO-15' },
  outcome: { publicSummary: '修复及相关数据库测试已通过，完整发布检查尚未通过。',
    blockers: [{ owner: '本机负责人', reason: '本机缺少完整测试环境，提交前质量门未通过。', resumeWhen: '确认只推审阅分支，交由 CI 继续验证。' }],
    next: '确认是否允许仅提交审阅分支；不包含合并或发布。' },
  workItems: [{ status: 'done' }, { status: 'done' }, { status: 'decision' }] };
const escape = text => String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const colors = { default: 'var(--fg)', grey: 'var(--muted)', 'grey-200': 'var(--border)', 'blue-50': 'var(--blue-bg)', 'orange-50': 'var(--orange-bg)', 'red-50': 'var(--red-bg)', 'grey-50': 'var(--neutral-bg)' };
const renderNode = e => {
  if (e.tag === 'hr') return '<hr>';
  if (e.tag === 'column_set') return `<div class="columns">${e.columns.map(renderNode).join('')}</div>`;
  if (e.tag === 'column') return `<section style="background:${colors[e.background_style]};padding:${e.padding};gap:${e.vertical_spacing}">${e.elements.map(renderNode).join('')}</section>`;
  if (e.tag === 'collapsible_panel') return `<details ${e.expanded ? 'open' : ''}><summary>${escape(e.header.title.content)}</summary><div class="details-body">${e.elements.map(renderNode).join('')}</div></details>`;
  if (e.tag === 'button') return `<button type="button" onclick="this.textContent='示例链接，不打开业务工单'">${escape(e.text.content)}</button>`;
  if (e.tag === 'markdown') return `<h2>${escape(e.content.replaceAll('**', ''))}</h2>`;
  if (e.tag === 'div') return `<p class="${escape(e.text.text_size)}" style="color:${colors[e.text.text_color]}">${escape(e.text.content)}</p>`;
  throw new Error(`Unsupported preview node: ${e.tag}`);
};
const render = card => `<article><header class="${card.header.template}"><div class="header-line"><h2>${escape(card.header.title.content)}</h2>${card.header.text_tag_list.map(t => `<span class="tag">${escape(t.text.content)}</span>`).join('')}</div></header><div class="body">${card.body.elements.map(renderNode).join('')}</div></article>`;
const complete = { ...task, workItems: task.workItems.map(() => ({ status: 'done' })),
  outcome: { publicSummary: '修复已提交审阅分支，CI 验证通过。提交及验证记录已写回工单，等待人工验收。' } };
const cards = ['decision', 'report', 'review'].map(type => feishuCard(notificationText(type === 'review' ? complete : task, type), type));
await mkdir('.local/notification-preview', { recursive: true });
await writeFile('.local/notification-preview/payloads.json', JSON.stringify(cards, null, 2));
await writeFile('.local/notification-preview/index.html', `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>任务通知卡片预览</title>
<style>
:root{color-scheme:light dark;--page:#f2f3f5;--surface:#fff;--fg:#1f2329;--muted:#646a73;--border:#dee0e3;--blue-bg:#f0f4ff;--orange-bg:#fff3e5;--red-bg:#fef0f0;--neutral-bg:#f5f6f7;--blue:#1456f0;--orange:#a44904;--red:#c02a26}
@media(prefers-color-scheme:dark){:root{--page:#141414;--surface:#1a1a1a;--fg:#ebebeb;--muted:#a6a6a6;--border:#434343;--blue-bg:#152340;--orange-bg:#33210b;--red-bg:#3d1a19;--neutral-bg:#292929;--blue:#75a4ff;--orange:#f3871b;--red:#f6827e}}
*{box-sizing:border-box}body{margin:0;background:var(--page);color:var(--fg);font:14px/1.6 system-ui,sans-serif;padding:24px}h1{font-size:24px;margin:0}body>p{color:var(--muted);margin:8px 0 24px}main{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,480px),1fr));gap:24px;align-items:start;max-width:1824px}article{container-type:inline-size;background:var(--surface);border:1px solid var(--border);border-radius:12px;overflow:hidden}header{padding:16px}.header-line{display:flex;gap:8px;flex-wrap:wrap;align-items:center;justify-content:space-between}.header-line h2{font-size:20px;line-height:1.4}.tag{border:1px solid currentColor;border-radius:4px;padding:1px 6px;font-size:12px;white-space:nowrap}.orange{background:var(--orange-bg);color:var(--orange)}.red{background:var(--red-bg);color:var(--red)}.blue{background:var(--blue-bg);color:var(--blue)}.grey{background:var(--neutral-bg);color:var(--muted)}.body{padding:16px;display:flex;flex-direction:column;gap:12px}p{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}.heading{font-size:20px;line-height:1.4}.notation{font-size:12px;line-height:1.5}h2{font-size:14px;margin:0;font-weight:650}.columns{display:grid;grid-template-columns:repeat(auto-fit,minmax(0,1fr));grid-auto-flow:column;gap:12px}section{display:flex;flex-direction:column;min-width:0}.details-body{display:flex;flex-direction:column;gap:8px;padding:12px}.details-body h2:not(:first-child){margin-top:8px}details{border:1px solid var(--border);border-radius:8px}summary{padding:10px 12px;cursor:pointer;min-height:44px}summary:hover{background:var(--neutral-bg)}button{font:inherit;background:#1456f0;color:white;border:0;padding:8px 16px;border-radius:6px;min-height:40px;cursor:pointer}button:hover{background:#0442d2}:focus-visible{outline:2px solid var(--blue);outline-offset:3px}::selection{background:#c2d4ff;color:#1f2329}@container(max-width:440px){.columns{grid-template-columns:1fr;grid-auto-flow:row}}@media(max-width:600px){body{padding:16px}}
</style>
<h1>先看状态，再看卡点</h1><p>通知布局预览 · 虚构示例 · 使用实际发送 payload；飞书客户端最终排版可能不同。</p><main>${cards.map(render).join('')}</main></html>`);
console.log('Preview generated: .local/notification-preview/index.html');
await writeFile('.local/notification-preview/mobile.html', (await readFile('.local/notification-preview/index.html', 'utf8')).replace('</style>', 'body{max-width:360px;padding:16px}main{grid-template-columns:1fr}</style>'));
