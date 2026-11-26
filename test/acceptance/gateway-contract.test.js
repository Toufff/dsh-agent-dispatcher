// Contract cross-check, opt-in: the quant-mining gateway client (zrstudio/linear-gateway.mjs / .ps1) against THIS
// dispatcher's real command handler. Set DSH_ACCEPT_QM_ROOT=<quant-mining checkout with zrstudio/linear-gateway.mjs>.
//
// A local HTTP server stands in for the DSH web host (cookie on GET /, POST /api/agentDispatcher/command with the
// client-request envelope, answer {result:{value}}); it validates every request with the real remote.js command
// schema and hands it to Runtime.command of an acceptance world (temp store, synthetic Linear, fake executor).
// The client side uses its real hostTransport (temp HOME with .dsh/web-url.txt), and the PowerShell side runs the
// real linear-gateway.ps1 -> node CLI -> hostTransport path. Nothing reaches Linear or any non-loopback address.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { world, botLinear } from './harness.js';
import { remote } from '../../src/remote.js';

const qmRoot = process.env.DSH_ACCEPT_QM_ROOT;
const skip = !qmRoot || !existsSync(path.join(qmRoot, 'zrstudio', 'linear-gateway.mjs'));
const commandSchema = () => remote.methods['agentDispatcher/command'].parameters[0].codec.create();
const loopbackOnly = url => { const u = new URL(url); if (!['127.0.0.1', 'localhost'].includes(u.hostname)) throw new Error(`network forbidden: ${url}`); };

async function fakeHost(runtimeOf) {
  const schema = commandSchema(), seen = [];
  const server = http.createServer(async (req, res) => {
    const send = (status, body, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(body)); };
    if (req.method === 'GET') return send(200, {}, { 'set-cookie': 'dsh=session; Path=/; HttpOnly' });
    if (req.method !== 'POST' || req.url !== '/api/agentDispatcher/command') return send(404, {});
    if (!/dsh=session/.test(req.headers.cookie || '')) return send(401, {});
    let text = ''; for await (const chunk of req) text += chunk;
    const body = JSON.parse(text);
    if (body.type !== 'client-request' || body.method !== 'agentDispatcher/command') return send(400, { error: { message: 'bad envelope' } });
    const request = body.payload?.args?.request;
    seen.push(request);
    const parsed = schema.safeParse(request);
    if (!parsed.success) return send(200, { error: { message: `schema: ${parsed.error.issues.map(i => i.path.join('.')).join(',')}` } });
    try { send(200, { result: { value: await runtimeOf().command(parsed.data) } }); }
    catch (error) { send(200, { error: { message: String(error.message).slice(0, 200) } }); }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { server, seen, url: `http://127.0.0.1:${server.address().port}/` };
}

test('(k) contract: quant-mining gateway client <-> dispatcher command handler (director enqueue, batched flush, result, push-queue view)', { skip }, async () => {
  const gw = await import(pathToFileURL(path.join(qmRoot, 'zrstudio', 'linear-gateway.mjs')).href);
  const w = await world({ settings: s => {
    s.linear = botLinear(); s.projects[0].linear.teamId = 'team'; s.projects[0].followup.commentAuthorIds = ['touf']; return s; } });
  const home = await mkdtemp(path.join(os.tmpdir(), 'dispatch-accept-gwhome-'));
  const host = await fakeHost(() => w.runtime);
  const fetchImpl = async (url, init) => { loopbackOnly(url); return fetch(url, init); };
  try {
    await mkdir(path.join(home, '.dsh'), { recursive: true });
    await writeFile(path.join(home, '.dsh', 'web-url.txt'), host.url);
    w.linear.issue('lx-1', { identifier: 'LX-1', delegate: { id: 'bot' }, assignee: { id: 'touf' } });
    w.executor.script('LX-1', 'blocked');
    await w.cycle(2);

    // ---- director: enqueue a review comment (by identifier) and a delegated issueCreate ----
    const client = gw.gatewayClient({ caller: 'director', transport: gw.hostTransport({ home, fetchImpl }) });
    let items = {};
    const review = await gw.sendOrDefer(items, 'review:LX-1:abc123', { kind: 'comment', issue: 'LX-1', body: '复审：结论成立' }, { issue: 'LX-1' }, client);
    items = { ...items, ...review.updates };
    const propose = await gw.sendOrDefer(items, 'propose:2026-11-26:def456',
      { kind: 'issueCreate', input: { teamId: 'team', projectId: 'lp', title: '研究主管：新方向', description: '正文', delegateToBot: true } }, { title: '研究主管：新方向' }, client);
    items = { ...items, ...propose.updates };
    assert.equal(review.down, null); assert.equal(propose.down, null);
    assert.equal(items['review:LX-1:abc123'].status, 'queued'); assert.equal(items['propose:2026-11-26:def456'].status, 'queued');
    // A rerun of the same step: local hit, no RPC; a direct re-enqueue: the dispatcher answers duplicate.
    const rpcs = host.seen.length;
    assert.equal((await gw.sendOrDefer(items, 'review:LX-1:abc123', { kind: 'comment', issue: 'LX-1', body: '复审：结论成立' }, {}, client)).existed, true);
    assert.equal(host.seen.length, rpcs);
    assert.equal((await client.enqueue('review:LX-1:abc123', { kind: 'comment', issue: 'LX-1', body: '复审：结论成立' })).status, 'duplicate');
    // Before the flush the dispatcher reports them queued.
    let synced = await gw.syncOutbox(items, client);
    assert.equal(synced.down, null);
    items = { ...items, ...synced.updates };
    assert.equal(items['review:LX-1:abc123'].status, 'queued');

    // ---- flush: one aliased mutation carries both director writes ----
    const before = w.linear.calls.length, batches = w.linear.batches || 0;
    await w.cycle(1);
    const writes = w.linear.calls.slice(before).filter(c => c.query.startsWith('mutation('));
    assert.equal(writes.length, 1, `write requests: ${writes.length}`);
    assert.equal((w.linear.batches || 0) - batches, 1);
    synced = await gw.syncOutbox(items, client);
    items = { ...items, ...synced.updates };
    const r = items['review:LX-1:abc123'], p = items['propose:2026-11-26:def456'];
    assert.equal(r.status, 'sent'); assert.ok(r.result?.commentId);
    assert.equal(p.status, 'sent'); assert.match(p.result?.issueIdentifier || '', /^NEW-\d+$/);
    const created = [...w.linear.issues.values()].find(i => i.identifier === p.result.issueIdentifier);
    assert.equal(created.delegate?.id, 'bot', 'delegateToBot resolved to the bot identity');
    const comment = w.linear.writes.find(x => x.kind === 'comment' && x.body === '复审：结论成立');
    assert.equal(comment.issueId, 'lx-1', 'identifier resolved to the issue id from the sync cache');
    assert.equal(w.linear.writes.filter(x => x.body === '复审：结论成立').length, 1);

    // ---- contract edges: client-side whitelist, server-side schema refusal, unknown id ----
    await assert.rejects(client.enqueue('bad:1', { kind: 'issueUpdate', issue: 'LX-1', input: { title: 'x' } }), gw.GatewayError);
    await assert.rejects(gw.hostTransport({ home, fetchImpl })({ action: 'linear-view', bogus: 1 }), /dispatcher error: .*schema/);
    assert.equal((await client.result(['no-such-id']))[0].status, 'failed');
    assert.deepEqual(await client.result([]), []);

    // ---- push-queue: linear-view through linear-gateway.ps1, classified the way push-queue.ps1 does ----
    const since = new Date(Date.now() - 60_000).toISOString();
    w.linear.comment('lx-1', 'touf', 'owner：请推送一下');
    w.linear.comment('lx-1', 'bot', 'ZRSTUDIO：进行中');
    w.linear.comment('lx-1', 'stranger', '随便说说');
    await w.cycle(2);
    const view = await client.view({ projectId: 'lp', since, include: ['issues', 'comments'] });
    assert.ok(view.cacheAt); assert.ok(view.issues.some(i => i.identifier === 'LX-1'));
    const script = path.join(home, 'view.ps1');
    await writeFile(script, [
      'param($qm, $since)',
      '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
      ". (Join-Path $qm 'zrstudio/linear-auth.ps1'); . (Join-Path $qm 'zrstudio/linear-gateway.ps1')",
      "$botCfg = [pscustomobject]@{ mode = 'bot'; botUserId = 'bot'; ownerUserIds = @('touf'); trustedUserIds = @() }",
      "$pushCfg = [pscustomobject]@{ ownerPrefixes = @('owner：'); ignorePrefixes = @('ZRSTUDIO：'); urgeKeywords = @('推送') }",
      "$v = Get-LinearGatewayView $qm 'lp' ([DateTimeOffset]::Parse($since).UtcDateTime)",
      'if (-not $v.Ok) { @{ ok = $false; error = $v.Error } | ConvertTo-Json -Compress; exit 0 }',
      '$rows = foreach ($c in @($v.Value.comments | Where-Object { $_ })) {',
      '  $node = [pscustomobject]@{ id = $c.id; body = $c.body; user = [pscustomobject]@{ id = $c.authorId }; authorIsBot = [bool]$c.authorIsBot }',
      "  $class = if ($node.authorIsBot) { 'bot-skip' } else { Get-LinearCommentClass $node $pushCfg $botCfg }",
      "  $urge = @($pushCfg.urgeKeywords | Where-Object { \"$($c.body)\".IndexOf($_, [StringComparison]::OrdinalIgnoreCase) -ge 0 }).Count -gt 0",
      '  @{ id = $c.id; issue = $c.issueIdentifier; author = $c.authorId; class = $class; urge = $urge }',
      '}',
      '@{ ok = $true; cacheAt = $v.Value.cacheAt; comments = @($rows) } | ConvertTo-Json -Depth 5 -Compress'
    ].join('\n'), { encoding: 'utf8' });
    // UTF-8 with BOM so Windows PowerShell-era parsing keeps the Chinese prefixes intact.
    const { readFile } = await import('node:fs/promises');
    await writeFile(script, '﻿' + await readFile(script, 'utf8'));
    const env = { ...process.env, USERPROFILE: home, HOME: home }; delete env.QM_LINEAR_GATEWAY_FAKE; delete env.QM_LINEAR_GATEWAY_CONFIG;
    const viewsBefore = host.seen.filter(q => q.action === 'linear-view').length;
    const { stdout } = await promisify(execFile)('pwsh', ['-NoProfile', '-NonInteractive', '-File', script, qmRoot, since], { env, timeout: 60_000 });
    const out = JSON.parse(stdout.trim().split('\n').at(-1));
    assert.equal(out.ok, true, out.error);
    const byAuthor = Object.fromEntries(out.comments.map(c => [c.author, c]));
    assert.equal(byAuthor.touf?.class, 'owner'); assert.equal(byAuthor.touf?.urge, true); assert.equal(byAuthor.touf?.issue, 'LX-1');
    assert.equal(byAuthor.bot?.class, 'bot-skip', 'the dispatcher marks its own bot comments');
    assert.equal(byAuthor.stranger?.class, 'other');
    assert.equal(host.seen.filter(q => q.action === 'linear-view').length, viewsBefore + 1, 'the ps1 path reached the dispatcher once');
    // The view and results never touched Linear: only the cycles did.
    const lastCycleCalls = w.linear.calls.length;
    await client.view({ projectId: 'lp' }); await client.result([r.id, p.id]);
    assert.equal(w.linear.calls.length, lastCycleCalls);
    assert.deepEqual(w.linear.unknown, []);
  } finally {
    host.server.close(); await w.close(); await rm(home, { recursive: true, force: true });
  }
});
