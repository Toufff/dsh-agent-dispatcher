#!/usr/bin/env node
/**
 * Reference focus-mode judge (settings.focus.judge). Reads the dispatcher's judge input as JSON on stdin:
 *   { focus: { issues, intent }, candidate: { identifier, title, description, parent, children, comments, mentions } }
 * (`mentions`: focus identifiers cited somewhere in the candidate's text — a hint only; citing a focus issue as a
 * reference or baseline does not make the candidate part of it).
 * asks an OpenAI-compatible chat-completions gateway whether the candidate belongs to what the owner is focusing on,
 * and prints one line { "verdict": "related" | "unrelated" | "uncertain", "reason": "..." }.
 *
 * Configuration is local only, by environment-variable NAMES (the values never appear in settings or logs):
 *   --key-env NAME       env var holding the API key            (default FOCUS_JUDGE_API_KEY)
 *   --gateway-env NAME   env var holding the gateway URL        (default FOCUS_JUDGE_GATEWAY)
 *   --gateway URL        gateway URL given directly (overrides --gateway-env)
 *   --model ID           model id (default: env FOCUS_JUDGE_MODEL, else deepseek-flash)
 *   --timeout-ms N       request timeout (default 45000; keep it below settings.focus.judge.timeoutMs)
 * Example settings: { "focus": { "judge": { "command": "node", "args": ["D:/dsh-agent-dispatcher/scripts/focus-judge.mjs",
 *   "--key-env", "LEIHUO_API_KEY", "--gateway", "https://<gateway>/v1/chat/completions"], "timeoutMs": 60000 } } }
 *
 * Any failure exits non-zero with a short message on stderr; the dispatcher then lists the issue for owner
 * confirmation and does not start it.
 */
import { pathToFileURL } from 'node:url';

export function parseArgs(argv) {
  const opts = { keyEnv: 'FOCUS_JUDGE_API_KEY', gatewayEnv: 'FOCUS_JUDGE_GATEWAY', gateway: null, model: null, timeoutMs: 45000 };
  for (let i = 0; i < argv.length; i++) {
    const [flag, value] = [argv[i], argv[i + 1]];
    if (flag === '--key-env') opts.keyEnv = value;
    else if (flag === '--gateway-env') opts.gatewayEnv = value;
    else if (flag === '--gateway') opts.gateway = value;
    else if (flag === '--model') opts.model = value;
    else if (flag === '--timeout-ms') opts.timeoutMs = Number(value);
    else throw new Error(`unknown argument ${flag}`);
    i++;
  }
  return opts;
}

export function buildMessages(input) {
  const system = [
    'You decide whether a work item belongs to what the owner is actively focusing on today.',
    'The owner named some focus issues and an intent. A candidate is RELATED if working on it directly serves that focus:',
    'it is part of the same requirement, a follow-up, split-off, handover, prerequisite, fix, review or verification of a focus issue,',
    'or the intent text explicitly covers it. It is UNRELATED if it is independent work that merely shares a topic or project.',
    'Answer UNCERTAIN when the evidence does not let you decide. Be lenient toward RELATED for clear dependencies,',
    'strict against generic topical similarity. candidate.mentions lists focus issues the text merely cites; citing a focus issue',
    'as a reference, baseline or comparison is NOT by itself a relation.',
    'Reply with one JSON object only: {"verdict":"related"|"unrelated"|"uncertain","reason":"<one sentence in Chinese>"}.',
  ].join(' ');
  const user = `Focus:\n${JSON.stringify(input.focus || {}, null, 1)}\n\nCandidate:\n${JSON.stringify(input.candidate || {}, null, 1)}`;
  return [{ role: 'system', content: system }, { role: 'user', content: user.slice(0, 24000) }];
}

/** The verdict object from a model reply: a ```json block or the last {...} with a verdict. */
export function parseReply(text) {
  const blocks = [...String(text || '').matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map(m => m[1]);
  const objects = String(text || '').match(/\{[^{}]*"verdict"[^{}]*\}/g) || [];
  for (const candidate of [...blocks.reverse(), ...objects.reverse(), text]) {
    try {
      const value = JSON.parse(String(candidate).trim());
      const verdict = String(value?.verdict || '').toLowerCase();
      if (['related', 'unrelated', 'uncertain'].includes(verdict)) return { verdict, reason: String(value.reason || '').slice(0, 400) };
    } catch { /* next */ }
  }
  throw new Error('model reply has no verdict JSON');
}

export async function judge(input, opts, env = process.env, fetchImpl = fetch) {
  const key = env[opts.keyEnv];
  if (!key) throw new Error(`${opts.keyEnv} not set`);
  const gateway = opts.gateway || env[opts.gatewayEnv];
  if (!gateway) throw new Error(`no gateway: pass --gateway or set ${opts.gatewayEnv}`);
  const model = opts.model || env.FOCUS_JUDGE_MODEL || 'deepseek-flash';
  const response = await fetchImpl(gateway, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, max_tokens: 400, temperature: 0, messages: buildMessages(input) }), signal: AbortSignal.timeout(opts.timeoutMs) });
  const json = await response.json().catch(() => ({}));
  // Never echo the request (it carries the key in a header only) and keep gateway errors short.
  if (!response.ok) throw new Error(`gateway HTTP ${response.status} ${JSON.stringify(json?.error?.message || json?.error || '').slice(0, 160)}`);
  return parseReply(json.choices?.[0]?.message?.content || '');
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  // Collect bytes and decode once: a multi-byte UTF-8 character may be split between chunks.
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString('utf8');
  const result = await judge(JSON.parse(raw), opts);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch(error => { process.stderr.write(`focus-judge: ${String(error?.message || error).slice(0, 300)}\n`); process.exit(1); });
}
