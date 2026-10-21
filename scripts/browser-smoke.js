import { chromium } from '@playwright/test';
import { readFile, mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';

const url = process.env.DSH_TEST_URL || (await readFile('.local/host.log', 'utf8')).match(/http:\/\/127\.0\.0\.1:\d+\/\?token=\S+/)?.[0];
if (!url) throw new Error('Set DSH_TEST_URL to the isolated DSH host URL');
const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
const errors = []; page.on('pageerror', error => errors.push(error.message));
try {
  await page.goto(url);
  const preview = page.getByRole('dialog', { name: '预览版说明' });
  if (await preview.isVisible({ timeout: 5000 }).catch(() => false)) await preview.getByRole('button', { name: '继续' }).click();
  await page.getByRole('button', { name: '任务派发', exact: true }).click();
  await page.getByRole('heading', { name: '执行优先级', exact: true }).waitFor();
  // Native host remote transport and durable priority roundtrip.
  const first = await page.locator('.executors li').first().locator('strong').innerText();
  await page.getByRole('button', { name: `下移 ${first}`, exact: true }).click();
  await page.getByRole('button', { name: '保存顺序', exact: true }).click();
  await page.getByRole('button', { name: '保存顺序', exact: true }).waitFor({ state: 'hidden' });
  assert.notEqual(await page.locator('.executors li').first().locator('strong').innerText(), first);
  await page.getByRole('button', { name: `上移 ${first}`, exact: true }).click();
  await page.getByRole('button', { name: '保存顺序', exact: true }).click();
  await page.getByRole('button', { name: '保存顺序', exact: true }).waitFor({ state: 'hidden' });
  await mkdir('.impeccable/review', { recursive: true });
  await page.screenshot({ path: '.impeccable/review/desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: '.impeccable/review/mobile.png', fullPage: true });
  if (await page.locator('.detail').count()) {
    await page.locator('.detail').scrollIntoViewIfNeeded();
    await page.screenshot({ path: '.impeccable/review/mobile-details.png', fullPage: true });
  }
  assert.equal(await page.locator('.dispatch').evaluate(el => el.scrollWidth > el.clientWidth + 1), false, 'Mobile panel overflows');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ nativeHost: true, priorityRoundtrip: true, mobileOverflow: false, pageErrors: errors.length }));
} finally { await browser.close(); }
