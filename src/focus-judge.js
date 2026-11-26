/**
 * Focus-mode model judge, production implementation: a locally configured command (settings.focus.judge; never
 * from an issue). It is spawned without a shell, gets the judge input as JSON on stdin and must print one JSON object
 * { verdict: 'related' | 'unrelated' | 'uncertain', reason } on stdout. Anything else (non-zero exit, timeout,
 * unparsable output, unknown verdict) is an error; the caller treats an error like 'uncertain' (never starts).
 *
 * The interface is pluggable: Runtime takes `focusJudge(input, { settings, env })` (tests pass a stub).
 */
import { spawn } from 'node:child_process';

const VERDICTS = new Set(['related', 'unrelated', 'uncertain']);
const MAX_OUTPUT = 64 * 1024;

/** The last JSON object on stdout with a valid verdict. */
export function parseJudgeOutput(text) {
  const lines = String(text || '').trim().split(/\r?\n/).reverse();
  for (const candidate of [String(text || '').trim(), ...lines]) {
    try {
      const value = JSON.parse(candidate);
      if (value && VERDICTS.has(value.verdict)) return { verdict: value.verdict, reason: String(value.reason || '').slice(0, 500) };
    } catch { /* next */ }
  }
  throw new Error('判定程序输出不是 {verdict, reason} JSON');
}

export function commandJudge(input, { settings, env = process.env, secretKeys = [] } = {}) {
  const judge = settings?.focus?.judge;
  if (!judge?.command) return Promise.reject(Object.assign(new Error('未配置模型判定（settings.focus.judge）'), { code: 'NO_JUDGE' }));
  // Linear tokens are not the judge's business.
  const childEnv = { ...env };
  for (const key of secretKeys) delete childEnv[key];
  return new Promise((resolve, reject) => {
    let out = '', settled = false;
    const child = spawn(judge.command, judge.args || [], { shell: false, windowsHide: true, env: childEnv, stdio: ['pipe', 'pipe', 'ignore'] });
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(value); };
    const timer = setTimeout(() => { child.kill(); finish(Object.assign(new Error(`判定超时（${judge.timeoutMs || 60000} ms）`), { code: 'JUDGE_TIMEOUT' })); }, judge.timeoutMs || 60000);
    child.on('error', error => finish(Object.assign(new Error(`判定程序无法启动：${String(error.message).slice(0, 200)}`), { code: 'JUDGE_ERROR' })));
    child.stdout.on('data', chunk => { out += chunk; if (out.length > MAX_OUTPUT) { child.kill(); finish(new Error('判定输出过长')); } });
    child.on('close', code => {
      if (code !== 0) return finish(Object.assign(new Error(`判定程序退出码 ${code}`), { code: 'JUDGE_ERROR' }));
      try { finish(null, parseJudgeOutput(out)); } catch (error) { finish(error); }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(input));
  });
}
