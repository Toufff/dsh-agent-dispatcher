import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { receiptWriter } from './receipt-writer.js';
import { access } from 'node:fs/promises';

let child, receipt, file, timer, persist, stopping = false, completed = false, started = false;
function save() { receipt.heartbeat = Date.now(); return persist(receipt); }
function send(value) { if (process.connected) process.send(value); }
process.on('message', async input => {
  if (input.stop && !stopping) {
    stopping = true;
    if (child?.pid) {
      if (process.platform === 'win32') {
        const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        killer.on('error', () => {});
      } else { try { process.kill(-child.pid, 'SIGTERM'); } catch {} }
    }
    return;
  }
  if (started) return;
  started = true; file = input.file; persist = receiptWriter(file);
  receipt = { status: 'starting', sessionId: input.sessionId, workerPid: process.pid, summary: '' };
  try {
    await save();
    child = spawn(input.command, input.args, { cwd: input.cwd, shell: false, windowsHide: true,
      detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    child.once('spawn', async () => {
      receipt.status = 'running'; receipt.pid = child.pid;
      try { await save(); send(receipt); } catch { send({ status: 'unknown' }); }
      child.stdin.end(input.prompt);
      timer = setInterval(async () => {
        try { await access(`${file}.stop`); process.emit('message', { stop: true }); } catch {}
        save().catch(() => {});
      }, 1000);
    });
    child.once('error', async error => {
      clearInterval(timer);
      receipt.status = ['ENOENT', 'EACCES'].includes(error.code) ? 'rejected' : 'unknown';
      receipt.reason = error.code || 'spawn-failed';
      try { await save(); send(receipt); }
      catch { send({ status: 'unknown', reason: 'Terminal receipt persistence failed' }); }
      finally { if (process.connected) process.disconnect(); }
    });
    child.stdin.on('error', () => {});
    // stderr is deliberately not persisted: third-party diagnostics may contain credentials.
    child.stderr.resume();
    const lines = createInterface({ input: child.stdout });
    lines.on('line', line => {
      if (line.length > 200000) return;
      let event; try { event = JSON.parse(line); } catch { return; }
      if (event.type === 'thread.started') receipt.sessionId = event.thread_id;
      if (event.type === 'system' && event.session_id) receipt.sessionId = event.session_id;
      if (event.type === 'item.completed' && event.item?.type === 'agent_message') receipt.summary = event.item.text?.slice(-12000) || '';
      if (event.type === 'turn.completed') completed = true;
      if (event.type === 'turn.failed' || event.type === 'error') receipt.reason = 'Agent reported an error';
      if (event.type === 'result') {
        completed = !event.is_error;
        receipt.summary = String(event.result ?? '').slice(-12000);
        if (event.is_error) receipt.reason = 'Agent reported an error';
      }
      save().catch(() => {});
    });
    child.once('close', async code => {
      clearInterval(timer);
      if (receipt.status === 'rejected') return;
      receipt.status = stopping ? 'stopped' : code === 0 && completed ? 'review' : 'failed';
      receipt.exitCode = code;
      if (!completed && !stopping) receipt.reason ||= 'No successful completion event';
      try { await save(); }
      catch { send({ status: 'unknown', reason: 'Terminal receipt persistence failed' }); }
      finally { if (process.connected) process.disconnect(); }
    });
  } catch {
    send({ status: 'unknown', reason: 'Receipt persistence failed' });
    if (process.connected) process.disconnect();
  }
});
