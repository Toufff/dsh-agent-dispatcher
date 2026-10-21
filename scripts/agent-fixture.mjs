const protocol = process.argv[2];
const emit = event => console.log(JSON.stringify(event));
process.stdin.resume();
process.stdin.on('end', () => {
  if (protocol === 'claude') {
    emit({ type: 'system', session_id: 'synthetic-claude-session' });
    emit({ type: 'result', is_error: false, result: 'SYNTHETIC_CLAUDE_OK' });
  } else if (protocol === 'codex') {
    emit({ type: 'thread.started', thread_id: 'synthetic-codex-session' });
    emit({ type: 'item.completed', item: { type: 'agent_message', text: 'SYNTHETIC_CODEX_OK' } });
    emit({ type: 'turn.completed' });
  } else if (protocol === 'hang') setInterval(() => {}, 1000);
  else console.log('Exit zero without a completion event');
});
