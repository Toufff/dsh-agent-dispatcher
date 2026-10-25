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
const render = card => `<article><header class="${card.header.template}">${escape(card.header.title.content)}</header><div class="body">${card.elements.map(e => {
  if (e.tag === 'hr') return '<hr>';
  if (e.tag === 'note') return `<footer>${escape(e.elements[0].content)}</footer>`;
  if (e.tag === 'action') return '<button disabled>打开 Linear 工单（示例）</button>';
  if (e.text.tag === 'lark_md') return `<h2>${escape(e.text.content.replaceAll('**', ''))}</h2>`;
  return `<p>${escape(e.text.content)}</p>`;
}).join('')}</div></article>`;
const complete = { ...task, workItems: task.workItems.map(() => ({ status: 'done' })),
  outcome: { publicSummary: '修复已提交审阅分支，CI 验证通过。提交及验证记录已写回工单，等待人工验收。' } };
const cards = ['decision', 'report', 'review'].map(type => feishuCard(notificationText(type === 'review' ? complete : task, type), type));
await mkdir('.local/notification-preview', { recursive: true });
await writeFile('.local/notification-preview/payloads.json', JSON.stringify(cards, null, 2));
await writeFile('.local/notification-preview/index.html', `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>任务通知卡片预览</title>
<style>body{margin:0;background:#f5f6f8;color:#242833;font:15px/1.6 system-ui,sans-serif;padding:28px}h1{font-size:25px;margin:0}body>p{color:#555e70;margin:8px 0 24px}main{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:24px;align-items:start;max-width:1500px}article{background:white;border:1px solid #d9dde5;border-radius:12px;overflow:hidden}header{padding:18px 20px;font-size:20px;font-weight:700}.orange{background:#fff0d8;color:#714600}.red{background:#fce5e7;color:#9b2031}.blue{background:#e8f0ff;color:#205abe}.grey{background:#eceef1;color:#555e70}.body{padding:16px 20px}p{margin:0 0 12px;white-space:pre-wrap;overflow-wrap:anywhere}.body>p:first-child{font-weight:600}h2{font-size:15px;margin:20px 0 6px}hr{border:0;border-top:1px solid #d9dde5;margin:18px 0}footer{font-size:12px;color:#555e70;margin-top:16px}button{font:inherit;background:#205abe;color:white;border:0;padding:10px 16px;border-radius:6px;margin:8px 0;min-height:44px}::selection{background:#c9dcff;color:#242833}@media(max-width:760px){body{padding:18px}main{grid-template-columns:1fr}}</style>
<h1>先看状态，再看卡点</h1><p>通知布局预览 · 虚构示例 · 使用实际发送 payload；飞书客户端最终排版可能不同。</p><main>${cards.map(render).join('')}</main></html>`);
console.log('Preview generated: .local/notification-preview/index.html');
await writeFile('.local/notification-preview/mobile.html', (await readFile('.local/notification-preview/index.html', 'utf8')).replace('</style>', 'body{max-width:360px;padding:16px}main{grid-template-columns:1fr}</style>'));
