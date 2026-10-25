import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import { Notifications, sendFeishu, loadFeishuCredentials, notificationText } from '../src/notifications.js';
import { Dispatcher, MemoryStore } from '../src/dispatcher.js';
import { initialState, settingsSchema } from '../src/config.js';
import { domainSpec } from '../src/plugin.js';
import { Runtime } from '../src/runtime.js';
import { feishuCard, notificationPresentation } from '../src/notification-card.js';

function cardNodes(node, includeCollapsed = true) {
  if (!node || typeof node !== 'object') return [];
  if (!includeCollapsed && node.tag === 'collapsible_panel' && !node.expanded) return [node];
  return [node, ...Object.values(node).flatMap(value => Array.isArray(value) ? value.flatMap(v => cardNodes(v, includeCollapsed)) : cardNodes(value, includeCollapsed))];
}

const channel = { id: 'personal', type: 'feishu', enabled: true, label: 'Personal', credentialsFile: path.join(os.tmpdir(), 'private.json'), projectIds: ['p'], includeExisting: true, completed: false };
async function fixture(send = async () => ({ status: 'sent' })) {
  const state = initialState();
  state.settings.projects = [{ id: 'p', label: 'Project', cwd: process.cwd() }];
  state.settings.notifications = { channels: [channel] };
  state.tasks = [{ id: 't', projectId: 'p', status: 'decision', issue: { id: 'i', identifier: 'EX-1', url: 'https://linear.app/example/issue/EX-1' }, summary: 'secret never export', prompt: 'private', attempts: [] }];
  const store = new MemoryStore(); await store.save(state);
  const runtime = { store, dispatcher: new Dispatcher({ store, adapters: {} }) };
  let now = 100000;
  const notifications = new Notifications(runtime, { send, clock: () => now });
  return { store, runtime, notifications, advance: n => now += n, edit: fn => runtime.dispatcher.update(fn) };
}
test('persisted incident sends once across polls/restart, omitting task secrets', async () => {
  const messages = [], f = await fixture(async (_c, text) => { messages.push(text); return { status: 'sent' }; });
  await f.notifications.run(); f.advance(2000); await f.notifications.run();
  await new Notifications(f.runtime, { send: async () => { throw Error('duplicate'); } }).run();
  assert.equal(messages.length, 1); assert.match(messages[0], /EX-1/); assert.doesNotMatch(messages[0], /secret|private/);
  const state = await f.store.load(); assert.equal(state.tasks[0].status, 'decision');
  assert.equal(domainSpec.global.schema.parse(state).notifications.outbox[0].status, 'sent');
});
test('existing incidents baseline quietly unless explicitly included; recurrence alerts', async () => {
  let sent = 0; const f = await fixture(async () => { sent++; return { status: 'sent' }; });
  await f.edit(s => { s.settings.notifications.channels[0].includeExisting = false; });
  await f.notifications.run(); assert.equal(sent, 0);
  await f.edit(s => { s.tasks[0].status = 'running'; }); await f.notifications.run();
  await f.edit(s => { s.tasks[0].status = 'decision'; }); await f.notifications.run(); assert.equal(sent, 1);
});

test('notification explains business progress, blockers and local continuation separately', async () => {
  const messages = [], f = await fixture(async (_c, text) => { messages.push(text); return { status: 'sent' }; });
  await f.edit(s => Object.assign(s.tasks[0], {
    title: 'EX-1 · 归档校验 · 续办 · 续办', status: 'stalled', continuationStop: 'budget',
    outcome: { progress: '归档复制已完成，恢复抽验尚未通过。', remaining: ['核验恢复结果'], next: '收到明细后复核。',
      blockers: [{ owner: 'Example User', reason: '缺少校验明细', resumeWhen: '交付逐文件校验清单' }] },
    workItems: [{ status: 'done' }, { status: 'ready' }, { status: 'blocked' }]
  }));
  await f.notifications.run();
  assert.match(messages[0], /任务：EX-1 · 归档校验\n/);
  assert.match(messages[0], /阶段进展或总次数保护上限/);
  assert.match(messages[0], /执行者报告：归档复制已完成/);
  assert.match(messages[0], /1\/3 完成，1 项可继续/);
  assert.match(messages[0], /缺少校验明细（责任方：Example User）/);
  assert.match(messages[0], /恢复条件：交付逐文件校验清单/);
  assert.match(messages[0], /未完成：核验恢复结果/);
  assert.match(messages[0], /现在需要：本地负责人/);
  // Updating the summary must not turn every poll into another alert.
  await f.edit(s => { s.tasks[0].outcome.progress = '有更新的业务报告'; });
  f.advance(2000); await f.notifications.run(); assert.equal(messages.length, 1);
});

test('notification excludes raw output, known secrets and unsafe full fields before truncating', () => {
  const secret = 'test-credential-not-for-sharing';
  const task = { issue: { identifier: 'EX-1' }, title: 'F:/private/project', summary: 'RAW_TRANSCRIPT',
    prompt: 'RAW_PROMPT', outcome: { publicSummary: 'x'.repeat(450) + secret, progress: '安全的简短进展',
      next: 'token=hidden', remaining: ['访问 https://private.example/secret', '公开未完成步骤'],
      blockers: [{ owner: secret, reason: '缺少验收回执', resumeWhen: '/home/private/receipt' }] } };
  const text = notificationText(task, 'unrouted', [secret]);
  assert.match(text, /安全的简短进展/); assert.match(text, /公开未完成步骤/); assert.match(text, /缺少验收回执/);
  assert.doesNotMatch(text, /RAW_|private|credential|hidden|xxxx/);
  task.outcome = {};
  assert.match(notificationText(task, 'unrouted'), /未提供可分享的进展/);
  task.outcome = { publicSummary: '公开摘要', progress: '不会重复的内部进展' };
  const preferred = notificationText(task, 'review');
  assert.match(preferred, /公开摘要/); assert.doesNotMatch(preferred, /内部进展/);
});
test('ordinary waits and unrelated projects are silent; latest issue task supersedes history', async () => {
  let sent = 0; const f = await fixture(async () => { sent++; return { status: 'sent' }; });
  await f.edit(s => { s.tasks.push({ ...s.tasks[0], id: 'new', status: 'blocked', wait: { status: 'watching' } }); s.tasks.push({ ...s.tasks[0], id: 'other', projectId: 'q' }); });
  await f.notifications.run(); assert.equal(sent, 0);
});
test('rate limited delivery retries independently, resolved pending incident cancels', async () => {
  let sent = 0; const f = await fixture(async () => { sent++; return { status: 'pending', retryMs: 60000 }; });
  await f.notifications.run(); f.advance(1000); await f.notifications.run(); assert.equal(sent, 1);
  await f.edit(s => { s.tasks[0].status = 'running'; }); f.advance(60000); await f.notifications.run();
  assert.equal(sent, 1); assert.equal((await f.store.load()).notifications.outbox[0].status, 'superseded');
});
test('rate limit retries have a finite budget', async () => {
  let sent = 0; const f = await fixture(async () => { sent++; return { status: 'pending', retryMs: 60000 }; });
  for (let i = 0; i < 5; i++) { await f.notifications.run(); f.advance(60000); }
  assert.equal(sent, 3); assert.equal((await f.store.load()).notifications.outbox[0].status, 'failed');
});
test('concurrent flushes are single flight, durable sending intent precedes network', async () => {
  let release, sent = 0, intent;
  const f = await fixture(async () => { sent++; intent = (await f.store.load()).notifications.outbox[0].status; await new Promise(r => { release = r; }); return { status: 'sent' }; });
  const a = f.notifications.run(), b = f.notifications.run(); assert.equal(a, b);
  while (!release) await new Promise(r => setTimeout(r, 1));
  assert.equal(intent, 'sending'); release(); await a; assert.equal(sent, 1);
});
test('interrupted sending becomes unknown and is not replayed', async () => {
  const f = await fixture(); await f.notifications.run();
  await f.edit(s => { s.notifications.outbox[0].status = 'sending'; });
  await new Notifications(f.runtime, { send: async () => { assert.fail('replayed'); } }).run();
  assert.equal((await f.store.load()).notifications.outbox[0].status, 'unknown');
});
test('disabled/changed destination cancels old retries and cannot leak to old channel', async () => {
  let sent = 0; const f = await fixture(async () => { sent++; return { status: 'pending', retryMs: 1000 }; });
  await f.notifications.run(); await f.edit(s => { s.settings.notifications.channels[0].enabled = false; });
  f.advance(5000); await f.notifications.run(); assert.equal(sent, 1);
  assert.equal((await f.store.load()).notifications.outbox[0].status, 'superseded');
});
test('completed is opt-in; monitor/report failures notify only at threshold', async () => {
  let sent = 0; const f = await fixture(async () => { sent++; return { status: 'sent' }; });
  await f.edit(s => { s.tasks[0].status = 'blocked'; s.tasks[0].wait = { status: 'watching', errorCount: 2 }; });
  await f.notifications.run(); assert.equal(sent, 0);
  await f.edit(s => { s.tasks[0].wait.errorCount = 3; }); await f.notifications.run(); assert.equal(sent, 1);
  await f.edit(s => { s.tasks[0].status = 'review'; }); f.advance(2000); await f.notifications.run(); assert.equal(sent, 1);
});
test('config refuses secrets in shared settings and duplicate channels', () => {
  const s = initialState().settings; s.projects = [{ id: 'p', label: 'P', cwd: process.cwd() }];
  s.notifications = { channels: [{ ...channel, webhook: 'private' }] };
  assert.equal(settingsSchema.safeParse(s).success, false);
  s.notifications.channels = [channel, channel]; assert.equal(settingsSchema.safeParse(s).success, false);
});
test('runtime cycle keeps progressing while a notification transport is blocked', async () => {
  const f = await fixture();
  const runtime = await new Runtime({ store: f.store, directory: os.tmpdir(), env: {} }).init();
  runtime.adapters = {}; runtime.lastHealth = Date.now();
  let release, calls = 0;
  runtime.notifications.send = async () => { calls++; await new Promise(resolve => { release = resolve; }); return { status: 'sent' }; };
  await runtime.cycle();
  while (!release) await new Promise(resolve => setTimeout(resolve, 1));
  const pending = runtime.notifications.pending;
  await runtime.cycle(); assert.equal(calls, 1); assert.equal(runtime.cycling, false);
  release(); await pending;
  assert.equal((await f.store.load()).tasks[0].status, 'decision');
});
test('Feishu signing, fixed destination, API errors, ambiguous timeout redaction', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'feishu-test-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'credentials.json'), c = { ...channel, credentialsFile: file };
  await writeFile(file, JSON.stringify({ webhook: 'https://open.feishu.cn/open-apis/bot/v2/hook/test-only', signingSecret: 'test-secret' }));
  const ok = await sendFeishu(c, 'test', { clock: () => 100000, fetchImpl: async (url, options) => {
    assert.equal(options.redirect, 'error'); assert.ok(options.signal);
    const body = JSON.parse(options.body); assert.equal(body.timestamp, '100');
    assert.equal(body.msg_type, 'interactive');
    assert.equal(body.card.header.template, 'grey');
    assert.equal(body.sign, createHmac('sha256', '100\ntest-secret').update('').digest('base64'));
    return new Response('{"code":0}');
  } }); assert.equal(ok.status, 'sent');
  await sendFeishu(c, '任务派发通知 · EX-1\n具体进展\nhttps://linear.app/example/issue/EX-1\nhttps://evil.example/\nhttps://linear.app/example?token=hidden', { fetchImpl: async (_url, options) => {
    const card = JSON.parse(options.body).card;
    assert.equal(card.header.title.content, '历史通知 · EX-1');
    assert.equal(card.schema, '2.0');
    const button = card.body.elements.find(e => e.tag === 'button');
    assert.equal(button.text.content, '打开 Linear 工单');
    assert.deepEqual(button.behaviors, [{ type: 'open_url', default_url: 'https://linear.app/example/issue/EX-1' }]);
    assert.equal(cardNodes(card).find(e => e.text?.content.includes('https://evil.example/')).text.tag, 'plain_text');
    return new Response('{"code":0}');
  } });
  assert.equal((await sendFeishu(c, 'test', { fetchImpl: async () => new Response('{"code":19021,"msg":"test-secret"}') })).status, 'failed');
  const invalidCard = await sendFeishu(c, 'test', { fetchImpl: async () => new Response('{"code":11246,"msg":"test-secret"}') });
  assert.equal(invalidCard.status, 'failed'); assert.match(invalidCard.error, /卡片格式/); assert.doesNotMatch(invalidCard.error, /test-secret/);
  const unknown = await sendFeishu(c, 'test', { fetchImpl: async () => { throw Error('test-secret https://private'); } });
  assert.equal(unknown.status, 'unknown'); assert.doesNotMatch(JSON.stringify(unknown), /test-secret|private/);
  const limited = await sendFeishu(c, 'test', { fetchImpl: async () => new Response('', { status: 429, headers: { 'retry-after': '120' } }) });
  assert.equal(limited.retryMs, 120000);
  await writeFile(file, JSON.stringify({ webhook: 'https://evil.example/secret' }));
  await assert.rejects(loadFeishuCredentials(file), /凭据/);
});

test('cards put intervention, concrete blocker and action before progress without interpreting dynamic markup', () => {
  const task = { title: '归档核验', issue: { identifier: 'EX-1', url: 'https://linear.app/example/issue/EX-1' },
    outcome: { progress: '已复制归档，尚未验收', next: '请确认审阅分支提交例外', blockers: [
      { reason: '<at id=all>所有人</at> **缺少决定**', owner: 'Example User', resumeWhen: '明确回复提交范围' }
    ] } };
  const text = notificationText(task, 'decision');
  const card = feishuCard(text, 'decision');
  assert.equal(card.header.template, 'orange');
  assert.equal(card.header.title.content, '等待决定 · EX-1');
  assert.equal(card.header.text_tag_list[0].text.content, '需要你回复');
  const nodes = cardNodes(card), visible = cardNodes(card, false);
  const blocker = visible.find(e => e.text?.content.includes('<at'));
  assert.equal(blocker.text.tag, 'plain_text');
  assert.ok(visible.some(e => e.text?.content === task.outcome.next));
  assert.ok(!visible.some(e => e.text?.content === task.outcome.progress));
  assert.ok(nodes.some(e => e.text?.content === task.outcome.progress));
  assert.equal(nodes.filter(e => e.tag === 'button').length, 1);
  assert.equal(card.body.elements.find(e => e.tag === 'column_set').flex_mode, 'stretch');
  assert.equal(card.body.elements.find(e => e.tag === 'collapsible_panel').expanded, false);
  // Live custom-bot validation rejects two-value header padding despite the
  // documented shorthand; keep all four sides explicit for this container.
  assert.match(card.body.elements.find(e => e.tag === 'collapsible_panel').header.padding, /^(\d+px ){3}\d+px$/);
  assert.match(card.config.summary.content, /等待决定.*需要你回复/);
  const review = notificationPresentation(notificationText(task, 'review'), 'review');
  assert.equal(review.color, 'blue'); assert.equal(review.blocker, '');
  assert.match(review.operation, /尚未人工验收/);
  for (const type of ['monitor', 'report']) {
    const view = notificationPresentation(notificationText(task, type), type);
    assert.equal(view.color, 'red'); assert.doesNotMatch(view.blocker, /缺少决定/);
    assert.match(view.operation, type === 'report' ? /不会因此重跑/ : /不代表业务执行失败/);
  }
});

test('incident type travels with delivery; old text remains renderable without inventing health', async () => {
  let type;
  const f = await fixture(async (_channel, _text, options) => { type = options.type; return { status: 'sent' }; });
  await f.notifications.run(); assert.equal(type, 'decision');
  const old = feishuCard('任务派发通知 · EX-1\n旧格式说明', 'failed');
  assert.equal(old.header.template, 'red');
  assert.match(cardNodes(old, false).find(e => e.text?.content.includes('具体原因')).text.content, /未记录/);
  const unknown = feishuCard('旧通知\n原始说明');
  assert.equal(unknown.header.template, 'grey');
  assert.ok(cardNodes(unknown).some(e => e.text?.content === '原始说明'));
});

test('v2 cards retain literal long content, visible delivery summary, and safe no-link fallback', () => {
  const dynamic = '<at id=all>不要解释标记</at> **原文** ' + '长文本'.repeat(60);
  const text = `任务派发通知 · EX-1\n任务：${dynamic}\n当前情况：需要验收\n现在需要：${dynamic}\n执行者报告：${dynamic}`;
  const card = feishuCard(text, 'review');
  const visible = cardNodes(card, false);
  assert.ok(visible.some(e => e.text?.content === dynamic));
  assert.equal(visible.filter(e => e.tag === 'button').length, 0);
  assert.equal(card.header.template, 'blue');
  assert.ok(!cardNodes(card).some(e => ['note', 'action', 'lark_md'].includes(e.tag)));
  for (const node of cardNodes(card).filter(e => e.content?.includes('<at'))) assert.equal(node.tag, 'plain_text');
  const minimal = feishuCard('任务派发通知 · EX-2\n当前情况：出错', 'failed');
  assert.ok(cardNodes(minimal, false).some(e => e.text?.content.includes('打开工单核对')));
  assert.ok(!cardNodes(minimal).some(e => e.tag === 'collapsible_panel'));
});
