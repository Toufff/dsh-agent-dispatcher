// Isolated browser interaction tests: no credentials, Linear requests or executor launches.
import { build } from 'esbuild';
import { chromium } from '@playwright/test';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const directory = await mkdtemp(path.join(os.tmpdir(), 'dispatch-settings-ui-'));
const catalog = { viewer: { id: 'user', name: 'Example Owner' }, organization: { id: 'workspace', name: 'Example Workspace' },
  projects: [{ id: 'remote-project', name: 'Example Remote Project' }], users: [{ id: 'user', name: 'Example Owner' }, { id: 'peer', name: 'Example Peer' }],
  workflowStates: [{ id: 'ready', name: 'Todo', type: 'unstarted', team: { id: 'team', name: 'Example Team' } }, { id: 'review', name: 'In Review', type: 'started', team: { id: 'team', name: 'Example Team' } }] };
const initial = { revision: 0, paused: true, tasks: [
  { id: 'task-one', projectId: 'local', title: 'First example task', status: 'review', attempts: [], events: [], issue: { id: 'issue-one', identifier: 'EX-101' }, cwd: path.resolve('.') },
  { id: 'task-two', projectId: 'local', title: 'Second example task', status: 'stopped', attempts: [], events: [], cwd: path.resolve('.') }
], outbox: [], errors: [], health: {}, settings: {
  executors: [], projects: [{ id: 'local', label: 'Example Local', cwd: path.resolve('.'),
    linear: { tokenEnv: 'EXAMPLE_TOKEN', workspaceId: 'workspace', projectId: 'remote-project', assigneeId: 'user', readyStateId: 'ready', reviewStateId: 'review', enabled: false, since: '2026-01-01T00:00:00.000Z', round: '1' },
    executionInstructions: 'Preserve this local restriction', followup: { enabled: false, commentAuthorIds: ['peer'], maxWakeups: 6, observeAfterExpiry: true } }] } };
const result = await build({ stdin: { contents: `import React from 'react';import {createRoot} from 'react-dom/client';import {Panel} from './src/ui/panel.jsx';import css from './src/ui/style.css';
const style=document.createElement('style');style.textContent=css;document.head.append(style);
window.state=${JSON.stringify(initial)};window.saved=[];window.failConnection=false;window.failSave=false;
const api={snapshot:async()=>structuredClone(window.state),issueContext:async()=>({}),catalog:async()=>{if(window.failConnection)throw Error('Connection unavailable');return ${JSON.stringify(catalog)}},
checkDirectory:async cwd=>{if(cwd==='bad-path')throw Error('目录不存在');return {exists:true,cwd}},
command:async r=>{if(r.action!=='configure')throw Error('Unexpected action');if(window.failSave)throw Error('Settings changed in another window');if(r.revision!==window.state.revision)throw Error('Conflict');window.saved.push(r);window.state.settings=r.settings;window.state.revision++;return structuredClone(window.state)}};
createRoot(document.getElementById('root')).render(<Panel api={api}/>);`, loader: 'jsx', resolveDir: process.cwd() }, bundle: true, write: false, format: 'iife', loader: { '.css': 'text', '.svg': 'text' } });
await writeFile(path.join(directory, 'app.js'), result.outputFiles[0].text);
await writeFile(path.join(directory, 'index.html'), '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="margin:0"><div id="root"></div><script src="app.js"></script></body></html>');
const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'msedge', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } }); const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(pathToFileURL(path.join(directory, 'index.html')).href);
  await page.getByLabel('搜索任务', { exact: true }).fill('EX-101');
  assert.equal(await page.locator('.task-list li').count(), 1);
  await page.getByLabel('状态', { exact: true }).selectOption('attention');
  await page.getByText('没有符合筛选条件的任务。').waitFor();
  await page.getByRole('button', { name: '清除筛选', exact: true }).click();
  assert.equal(await page.locator('.task-list li').count(), 2);
  await page.getByRole('button', { name: '配置项目与连接', exact: true }).click();
  await page.getByRole('button', { name: '读取账号与项目', exact: true }).click();
  await page.locator('.connection-identity').getByText('Example Owner', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('Linear 项目', { exact: true }).inputValue(), 'remote-project');
  await page.getByLabel('本地工作目录', { exact: true }).fill('bad-path');
  await page.getByRole('button', { name: '检查目录', exact: true }).click();
  await page.getByRole('alert').getByText('目录不存在').waitFor();
  await page.getByLabel('本地工作目录', { exact: true }).fill(path.resolve('.'));
  await page.getByLabel('本机项目名称', { exact: true }).fill('Updated Local');
  await page.getByRole('button', { name: '保存配置', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '配置已保存' }).waitFor();
  const saved = await page.evaluate(() => window.saved.at(-1));
  assert.equal(saved.settings.projects[0].executionInstructions, 'Preserve this local restriction');
  assert.equal(saved.settings.projects[0].linear.enabled, false);
  assert.equal(saved.settings.projects[0].followup.maxWakeups, 6);
  assert.deepEqual(saved.settings.projects[0].followup.commentAuthorIds, ['peer']);
  assert.equal(saved.revision, 0);
  await page.evaluate(() => { window.failConnection = true; });
  await page.getByRole('button', { name: '读取账号与项目', exact: true }).click();
  await page.getByRole('alert').getByText('Connection unavailable').waitFor();
  assert.equal(await page.locator('.connection-identity').count(), 0);
  await page.evaluate(() => { window.failConnection = false; window.failSave = true; });
  await page.getByRole('button', { name: '读取账号与项目', exact: true }).click();
  await page.getByLabel('本机项目名称', { exact: true }).fill('Conflict draft');
  await page.getByRole('button', { name: '保存配置', exact: true }).click();
  await page.getByRole('alert').getByText('Settings changed in another window').waitFor();
  assert.equal(await page.getByLabel('本机项目名称', { exact: true }).inputValue(), 'Conflict draft');
  assert.equal(await page.evaluate(() => window.saved.length), 1);
  await page.evaluate(() => { window.failSave = false; });
  await page.getByRole('button', { name: '保存配置', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '配置已保存' }).waitFor();
  await page.getByRole('button', { name: '新增项目映射', exact: true }).click();
  await page.getByLabel('本机项目名称', { exact: true }).fill('Second mapping');
  await page.getByLabel('本地工作目录', { exact: true }).fill(path.resolve('.'));
  await page.getByLabel('为此项目配置 Linear', { exact: true }).check();
  await page.getByRole('button', { name: '读取账号与项目', exact: true }).click();
  await page.getByLabel('Linear 项目', { exact: true }).selectOption('remote-project');
  await page.getByLabel('接单状态', { exact: true }).selectOption('ready');
  await page.getByLabel('完成后的待验收状态', { exact: true }).selectOption('review');
  await page.getByText('外部回复与自动恢复 · 未启用', { exact: true }).click();
  await page.getByLabel('Example Peer', { exact: true }).check();
  // Navigation must protect the draft without making the task tab unusable.
  page.once('dialog', dialog => dialog.dismiss());
  await page.getByRole('navigation').getByRole('button', { name: '任务队列', exact: true }).click();
  assert.equal(await page.getByLabel('本机项目名称', { exact: true }).inputValue(), 'Second mapping');
  await page.getByRole('button', { name: '保存配置', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '配置已保存' }).waitFor();
  const added = await page.evaluate(() => window.saved.at(-1).settings.projects[1]);
  assert.equal(added.linear.workspaceId, 'workspace');
  assert.equal(added.linear.assigneeId, 'user');
  assert.equal(added.linear.enabled, false);
  assert.equal(added.followup.enabled, false);
  assert.deepEqual(added.followup.commentAuthorIds, ['peer']);
  await page.getByRole('button', { name: 'Conflict draft', exact: false }).click();
  await mkdir('.local/settings-ui', { recursive: true });
  for (const [name, width, scheme] of [['desktop',1280,'light'],['desktop-dark',1280,'dark'],['mobile',390,'light']]) {
    await page.setViewportSize({ width, height: 1000 }); await page.emulateMedia({ colorScheme: scheme });
    await page.screenshot({ path: `.local/settings-ui/${name}.png`, fullPage: true, animations: 'disabled' });
    assert.equal(await page.locator('.dispatch').evaluate(el => el.scrollWidth > el.clientWidth + 1), false, name);
  }
  await page.getByRole('navigation').getByRole('button', { name: '任务队列', exact: true }).click();
  await page.getByRole('heading', { name: '执行优先级', exact: true }).waitFor();
  assert.deepEqual(errors, []);
  assert.deepEqual(await page.evaluate(() => window.state.tasks), initial.tasks);
  // Full JSON configuration must also work when no projects remain.
  await page.getByRole('button', { name: '配置项目与连接', exact: true }).click();
  await page.getByText('高级配置 JSON（执行器命令与完整配置）', { exact: true }).click();
  const empty = await page.evaluate(() => ({ ...window.state.settings, projects: [] }));
  await page.getByLabel('本机配置 JSON', { exact: true }).fill(JSON.stringify(empty));
  await page.getByRole('button', { name: '载入草稿', exact: true }).click();
  await page.getByRole('button', { name: '保存配置', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '配置已保存' }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.state.settings.projects), []);
  console.log(JSON.stringify({ saveRoundtrip: true, emptyProjectSave: true, newMapping: true, taskFilters: true, unchangedTasks: true, draftNavigationGuard: true, preservedHiddenSettings: true, invalidDirectory: true, connectionFailure: true, staleSavePreservesDraft: true, responsive: true, errors }));
} finally { await browser.close(); await rm(directory, { recursive: true, force: true }); }
