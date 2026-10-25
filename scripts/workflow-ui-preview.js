// Isolated manual browser fixture: no tokens, Linear network calls or executors.
import { build } from 'esbuild';
import { createServer } from 'node:http';
const state = { revision: 0, paused: true, health: {}, errors: [], outbox: [], settings: { executors: [], projects: [
  { id: 'example', label: '示例项目', cwd: '/example/workspace', followup: { enabled: false } }
] }, tasks: [
  { id: 'old', projectId: 'example', title: '旧轮次（已被续办替代）', status: 'blocked', owner: 'scheduler', historical: true, attempts: [], events: [], cwd: '/example/workspace' },
  { id: 'current', projectId: 'example', title: '示例：完成修复及验证', status: 'stalled', owner: 'scheduler', attempts: [], events: [], cwd: '/example/workspace',
    attention: { owner: '本地负责人', reason: '自动续办预算已用完', action: '核对剩余阶段与有效约束，填写本轮要求后继续。' },
    workItems: [
      { id: 'code', title: '源码修复', status: 'done', dependsOn: [], action: '', evidence: ['隔离测试已通过；这是示例证据。'] },
      { id: 'verify', title: '剩余回归验证', status: 'ready', dependsOn: ['code'], action: '完成重启和重复触发回归', evidence: [] },
      { id: 'review', title: '评审回执', status: 'blocked', dependsOn: [], action: '', evidence: [], blocker: { owner: '示例评审人', reason: '评审回执尚未收到', resumeWhen: '关联工单收到可信评审回执' } }
    ] }
] };
const result = await build({ stdin: { resolveDir: process.cwd(), loader: 'jsx', contents: `
import React from 'react';import {createRoot} from 'react-dom/client';import {Panel} from './src/ui/panel.jsx';import css from './src/ui/style.css';
const style=document.createElement('style');style.textContent=css;document.head.append(style);
let state=${JSON.stringify(state)};
const api={snapshot:async()=>structuredClone(state), command:async request=>{
 if(request.action!=='continue')throw Error('隔离预览只允许测试续办');
 const receipt=document.getElementById('receipt');receipt.textContent='收到续办要求：'+request.prompt;
 return structuredClone(state);
}};
createRoot(document.getElementById('root')).render(<Panel api={api}/>);
` }, bundle: true, write: false, format: 'iife', loader: { '.css': 'text', '.svg': 'text' } });
const html = '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>隔离工作流预览</title><body style="margin:0"><div id="root"></div><p id="receipt" role="status"></p><script src="/app.js"></script></body></html>';
const server = createServer((req, res) => {
  res.setHeader('content-type', req.url === '/app.js' ? 'application/javascript' : 'text/html; charset=utf-8');
  res.end(req.url === '/app.js' ? result.outputFiles[0].text : req.url === '/mobile' ? '<!doctype html><title>390px 隔离预览</title><iframe title="窄屏任务派发" src="/" style="width:390px;height:1500px;border:0"></iframe>' : html);
});
server.listen(0, '127.0.0.1', () => console.log(`Isolated UI preview: http://127.0.0.1:${server.address().port}/ (narrow viewport: /mobile)`));
