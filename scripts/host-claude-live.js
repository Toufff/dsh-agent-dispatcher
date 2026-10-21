import { chromium } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const command = process.env.DISPATCH_SMOKE_COMMAND;
if (!command) throw new Error('Set DISPATCH_SMOKE_COMMAND to the official Claude executable');
const url = process.env.DSH_TEST_URL || (await readFile('.local/host.log', 'utf8')).match(/http:\/\/127\.0\.0\.1:\d+\/\?token=\S+/)?.[0];
const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'msedge', headless: true });
const page = await browser.newPage();
let original;
async function configure(settings) {
  await page.getByRole('button', { name: '配置项目与连接', exact: true }).click();
  await page.getByRole('textbox', { name: '本机配置 JSON' }).fill(JSON.stringify(settings));
  await page.getByRole('button', { name: '保存配置', exact: true }).click();
  await page.getByRole('button', { name: '保存配置', exact: true }).waitFor({ state: 'hidden' });
}
try {
  await page.goto(url);
  const preview = page.getByRole('dialog', { name: '预览版说明' });
  if (await preview.isVisible().catch(() => false)) await preview.getByRole('button', { name: '继续' }).click();
  await page.getByRole('button', { name: '任务派发', exact: true }).click();
  await page.getByRole('button', { name: '开启派发', exact: true }).waitFor();
  await page.getByRole('button', { name: '配置项目与连接', exact: true }).click();
  original = JSON.parse(await page.getByRole('textbox', { name: '本机配置 JSON' }).inputValue());
  await page.getByRole('button', { name: '关闭配置', exact: true }).click();
  const settings = structuredClone(original);
  const executor = settings.executors.find(e => e.type === 'claude');
  Object.assign(executor, { command, enabled: true, verified: true });
  settings.executors = [executor, ...settings.executors.filter(e => e.id !== executor.id)];
  await configure(settings);
  await page.getByRole('combobox', { name: '项目', exact: true }).selectOption(process.env.DISPATCH_SMOKE_PROJECT || 'acceptance');
  const title = `Claude CLI acceptance ${Date.now()}`;
  await page.getByRole('textbox', { name: '任务标题', exact: true }).fill(title);
  await page.getByRole('textbox', { name: '需求与验收条件', exact: true }).fill('Do not use tools or modify files. Reply exactly: DISPATCH_HOST_CLAUDE_OK');
  await page.getByRole('button', { name: '加入队列', exact: true }).click();
  await page.getByRole('button', { name: '开启派发', exact: true }).click();
  await page.getByRole('button', { name: `${title} 待验收`, exact: true }).waitFor({ timeout: 180000 });
  assert.match(await page.locator('.detail pre').innerText(), /DISPATCH_HOST_CLAUDE_OK/);
  const session = await page.locator('.detail .attempt code').last().innerText();
  await page.getByRole('button', { name: '人工接管', exact: true }).click();
  await page.getByLabel('我已结束人工会话，确认可继续派发').check();
  await page.getByRole('button', { name: '归还控制', exact: true }).click();
  await page.getByRole('button', { name: '重试任务', exact: true }).click();
  await page.getByRole('button', { name: '本地确认验收', exact: true }).waitFor({ timeout: 180000 });
  assert.equal(await page.locator('.detail .attempt code').last().innerText(), session);
  assert.match(await page.locator('.detail pre').innerText(), /DISPATCH_HOST_CLAUDE_OK/);
  Object.assign(original.executors.find(e => e.type === 'claude'), { command, verified: true });
  console.log(JSON.stringify({ packagedClaudeExecution: true, takeoverReturn: true, sameSessionResume: true }));
} finally {
  if (await page.getByRole('button', { name: '暂停派发', exact: true }).isVisible().catch(() => false))
    await page.getByRole('button', { name: '暂停派发', exact: true }).click();
  if (original) await configure(original);
  await browser.close();
}
