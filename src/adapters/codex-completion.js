import { readdir, open } from 'node:fs/promises';
import path from 'node:path';

export function completedTurn(text, startedAt) {
  const events = text.split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } })
    .filter(e => e.type === 'event_msg' && ['task_started', 'task_complete', 'turn_aborted'].includes(e.payload?.type));
  const last = events.at(-1);
  return last?.payload.type === 'task_complete' && Date.parse(last.timestamp) >= startedAt
    ? { at: last.timestamp, summary: last.payload.last_agent_message } : null;
}

/** Compatibility fallback for CLI versions whose terminal JSON event waits for teardown. */
export async function codexCompletion(root, sessionId, startedAt, cachedFile) {
  if (!/^[a-f0-9-]{36}$/i.test(sessionId || '')) return {};
  let file = cachedFile;
  if (!file) {
    const entries = await readdir(path.join(root, 'sessions'), { recursive: true });
    const name = entries.find(name => name.endsWith(`-${sessionId}.jsonl`));
    if (!name) return {};
    file = path.join(root, 'sessions', name);
  }
  const handle = await open(file, 'r');
  try {
    const { size } = await handle.stat();
    const buffer = Buffer.alloc(Math.min(size, 262144));
    await handle.read(buffer, 0, buffer.length, Math.max(0, size - buffer.length));
    return { file, completion: completedTurn(buffer.toString('utf8'), startedAt) };
  } finally { await handle.close(); }
}
