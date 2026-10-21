const protocol = process.argv[2];
const emit = event => console.log(JSON.stringify(event));
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
process.stdin.resume();
process.stdin.on('end', () => {
  if (protocol === 'codex-file-linger') {
    const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    emit({ type: 'thread.started', thread_id: id });
    const dir = path.join(process.env.CODEX_HOME, 'sessions'); mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, `rollout-${id}.jsonl`), JSON.stringify({ type: 'event_msg', timestamp: new Date().toISOString(), payload: { type: 'task_complete', last_agent_message: 'SYNTHETIC_CODEX_OK' } }) + '\n');
    setInterval(() => {}, 1000); return;
  }
  if (protocol === 'claude') {
    emit({ type: 'system', session_id: 'synthetic-claude-session' });
    emit({ type: 'result', is_error: false, result: 'SYNTHETIC_CLAUDE_OK' });
  } else if (['codex', 'codex-linger'].includes(protocol)) {
    emit({ type: 'thread.started', thread_id: 'synthetic-codex-session' });
    emit({ type: 'item.completed', item: { type: 'agent_message', text: 'SYNTHETIC_CODEX_OK' } });
    emit({ type: 'turn.completed' });
    if (protocol === 'codex-linger') setInterval(() => {}, 1000);
  } else if (protocol === 'hang') setInterval(() => {}, 1000);
  else console.log('Exit zero without a completion event');
});
