import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { receiptWriter } from './receipt-writer.js';
import { captureResultText } from '../result-text.js';
import { access } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { codexCompletion } from './codex-completion.js';

let child, receipt, file, timer, persist, stopping = false, completed = false, started = false;
let finishTimer, cleanupTimer, cleanup = false, closed = false, sessionFile, observing = false, nextObservation = 0;
function terminate() {
  if (!child?.pid || closed) return;
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    killer.on('error', () => {});
  } else { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
}
function finish(input, source) {
  if (completed || closed) return;
  completed = true; receipt.status = 'finishing'; receipt.completedAt = new Date().toISOString(); receipt.completionSource = source;
  save().catch(() => {});
  finishTimer = setTimeout(() => {
    cleanup = true; terminate();
    cleanupTimer = setTimeout(() => {
      if (!closed) { receipt.status = 'unknown'; receipt.reason = 'Completion recorded; process cleanup unconfirmed'; save().catch(() => {}); }
    }, 10000);
  }, input.completionGraceMs ?? 15000);
}
function save() { receipt.heartbeat = Date.now(); return persist(receipt); }
function send(value) { if (process.connected) process.send(value); }
process.on('message', async input => {
  if (input.stop && !stopping) {
    stopping = true;
    terminate();
    return;
  }
  if (started) return;
  started = true; file = input.file; persist = receiptWriter(file);
  const startedAt = Date.now();
  receipt = { status: 'starting', sessionId: input.sessionId, workerPid: process.pid, summary: '', startedAt };
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
        if (input.type === 'codex' && !completed && !observing && Date.now() >= nextObservation) {
          observing = true;
          nextObservation = Date.now() + 5000;
          try {
            const result = await codexCompletion(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), receipt.sessionId, startedAt, sessionFile);
            sessionFile = result.file;
            if (result.completion && !closed) {
              if (typeof result.completion.summary === 'string') receipt.summary = captureResultText(result.completion.summary);
              finish(input, 'session-task-complete');
            }
          } catch {} finally { observing = false; }
        }
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
      if (line.length > 2000000) { receipt.reason = 'CLI event exceeded the bounded decoder limit'; return; }
      let event; try { event = JSON.parse(line); } catch { return; }
      if (event.type === 'thread.started') receipt.sessionId = event.thread_id;
      if (event.type === 'system' && event.session_id) receipt.sessionId = event.session_id;
      if (event.type === 'item.completed' && event.item?.type === 'agent_message') receipt.summary = captureResultText(event.item.text);
      if (event.type === 'turn.completed') finish(input, 'cli-turn-completed');
      if (event.type === 'turn.failed' || event.type === 'error') receipt.reason = 'Agent reported an error';
      if (event.type === 'result') {
        if (!event.is_error) finish(input, 'cli-result');
        receipt.summary = captureResultText(event.result);
        if (event.is_error) receipt.reason = 'Agent reported an error';
      }
      save().catch(() => {});
    });
    child.once('close', async code => {
      closed = true; clearTimeout(finishTimer); clearTimeout(cleanupTimer);
      clearInterval(timer);
      if (receipt.status === 'rejected') return;
      receipt.status = stopping ? 'stopped' : completed && (code === 0 || cleanup) ? 'review' : 'failed';
      if (cleanup && !stopping) receipt.reason = 'Completion recorded; lingering process cleaned up';
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
