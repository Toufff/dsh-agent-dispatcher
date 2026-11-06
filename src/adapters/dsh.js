import path from 'node:path';
import { captureResultText } from '../result-text.js';

const belongs = (message, attempt) => message?.source?.rpcId === attempt.id;
const pending = agent => [...agent.inbox.nextTurn, ...agent.inbox.nextStep];
function coldPending(events) {
  const queues = new Map();
  for (const event of events) if (event.type === 'agent/inbox/spliced') {
    const { target, start, inserted } = event.data;
    // DSH 0.2.2 omits removedCount for pure insertions; an event without a usable queue window is unreadable.
    const removedCount = event.data.removedCount ?? (Array.isArray(inserted) && Number.isInteger(start) ? 0 : undefined);
    if (removedCount === undefined) return null;
    const queue = queues.get(target) || [];
    queue.splice(start, removedCount, ...inserted); queues.set(target, queue);
  }
  return [...queues.values()].flat();
}

// Largest page the history API is asked for; long sessions are read in several pages at one fixed cut.
const HISTORY_PAGE = 1000;

export class DshAdapter {
  constructor(ctx, config = {}) { this.ctx = ctx; this.config = config; }

  /**
   * Durable session events (and the session header when cheaply known).
   * DSH <= 0.2.1 exposes sessionController.inspect. DSH 0.2.2 removed it: a live Agent's
   * session gives an exact in-memory snapshot, and a cold session is read through the paged
   * `events` history at one fixed cut, oldest page first.
   */
  async inspect(sessionId) {
    const controller = this.ctx.sessionController;
    if (typeof controller.inspect === 'function') return controller.inspect(sessionId);
    const live = this.ctx.agents?.get(sessionId)?.session;
    if (typeof live?.snapshotEvents === 'function') return { meta: live.header, events: live.snapshotEvents() };
    if (typeof controller.events !== 'function') throw new Error('DSH session history API unavailable');
    const signal = new AbortController().signal;
    const pages = [];
    let throughSeq, beforeSeq;
    for (;;) {
      const page = await controller.events({ address: { kind: 'session', sessionId }, maxMessages: HISTORY_PAGE,
        ...(throughSeq === undefined ? {} : { throughSeq }), ...(beforeSeq === undefined ? {} : { beforeSeq }) }, signal);
      throughSeq ??= page.cursor;
      const events = (page.records || []).filter(r => r.type === 'event').map(r => r.event);
      if (events.length) pages.unshift(events);
      if (!page.hasMore || !events.length) break;
      if (beforeSeq !== undefined && events[0].seq >= beforeSeq) throw new Error('DSH session history did not advance');
      beforeSeq = events[0].seq;
    }
    return { events: pages.flat() };
  }

  /** The session's working directory: from its header when available, else from the session list. */
  async cwd(sessionId, inspection) {
    if (inspection?.meta?.cwd) return inspection.meta.cwd;
    const controller = this.ctx.sessionController;
    if (typeof controller.list !== 'function') return inspection?.meta?.cwd;
    const listed = await controller.list({}, new AbortController().signal);
    return listed?.items?.find(item => item.sessionId === sessionId)?.cwd;
  }

  async start({ task, attempt }) {
    const controller = this.ctx.sessionController;
    if (!controller) return { status: 'rejected', reason: 'DSH session service unavailable' };
    if (attempt.resume) {
      const inspection = await this.inspect(attempt.sessionId);
      if (path.resolve((await this.cwd(attempt.sessionId, inspection)) || '') !== path.resolve(task.cwd))
        return { status: 'rejected', reason: 'Session directory differs from project' };
      const resolved = await controller.resolveAgent(attempt.sessionId);
      if (resolved.error) return { status: 'busy', reason: 'Session writer unavailable' };
      if (resolved.agent.status !== 'idle' || pending(resolved.agent).length)
        return { status: 'busy', reason: 'Session already has active or queued work' };
    } else {
      const created = await controller.create({ sessionId: attempt.sessionId, cwd: task.cwd,
        ...(this.config.preset ? { agentPreset: this.config.preset } : {}) });
      // Do not lose a changed identity across a crash before receipt persistence.
      if (created.sessionId !== attempt.sessionId)
        return { status: 'rejected', reason: 'Requested session identity could not be reserved' };
    }
    await controller.prompt({ sessionId: attempt.sessionId, requestId: attempt.id,
      mode: 'queue', content: [{ type: 'text', text: task.prompt }] }, new AbortController().signal);
    return { status: 'running', sessionId: attempt.sessionId, runId: attempt.id };
  }
  async reconcile({ attempt }) {
    const agent = this.ctx.agents?.get(attempt.sessionId);
    if (attempt.status === 'busy') return { status: agent?.status === 'idle' && !pending(agent).length ? 'ready' : 'busy' };
    const inspection = await this.inspect(attempt.sessionId);
    const events = inspection.events;
    const index = events.findIndex(event => event.type === 'agent/inbox/spliced'
      && event.data.inserted?.some(message => belongs(message, attempt)));
    if (index < 0) return { status: 'unknown', reason: 'Prompt admission not found in durable history' };
    if (agent?.status === 'running' || agent && pending(agent).some(m => belongs(m, attempt))) return { status: 'running' };
    const suffix = events.slice(index);
    const endIndex = suffix.findIndex(event => event.type === 'turn/end');
    const end = suffix[endIndex];
    if (!end) return { status: 'unknown', reason: 'No confirmed turn completion' };
    // A later manual/queued turn in the same session is not this attempt's receipt.
    const message = suffix.slice(0, endIndex).findLast(event => event.type === 'assistant/message');
    const content = message?.data?.message?.content ?? message?.data?.content ?? [];
    return { status: end.data.reason.kind === 'completed' ? 'review' : 'failed',
      reason: end.data.reason.kind,
      summary: Array.isArray(content) ? captureResultText(content.filter(p => p.type === 'text').map(p => p.text).join('\n')) : '' };
  }
  async idle({ attempt }) {
    const agent = this.ctx.agents?.get(attempt.sessionId);
    if (agent) return agent.status === 'idle' && pending(agent).length === 0;
    const inspection = await this.inspect(attempt.sessionId);
    const last = inspection.events.findLast(e => ['turn/start', 'turn/end'].includes(e.type));
    const queued = coldPending(inspection.events);
    return last?.type === 'turn/end' && queued !== null && queued.length === 0;
  }
  async stop(context) {
    const { attempt } = context;
    const agent = this.ctx.agents?.get(attempt.sessionId);
    if (!agent) return { status: await this.idle(context) ? 'stopped' : 'unknown' };
    for (const message of pending(agent)) if (belongs(message, attempt)) agent.inbox.remove(message.id);
    agent.cancel({ kind: 'user' }, { keepInbox: true });
    let timer;
    const idle = await Promise.race([agent.whenIdle().then(() => true), new Promise(r => { timer = setTimeout(() => r(false), 5000); })]);
    clearTimeout(timer);
    return { status: idle && !pending(agent).some(m => belongs(m, attempt)) ? 'stopped' : 'unknown' };
  }
  async health() { return { available: Boolean(this.ctx.sessionController), verification: 'host-service' }; }
}
