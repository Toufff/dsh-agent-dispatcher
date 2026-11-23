import path from 'node:path';
import { captureResultText } from '../result-text.js';

const belongs = (message, attempt) => message?.source?.rpcId === attempt.id;
const pending = agent => [...agent.inbox.nextTurn, ...agent.inbox.nextStep];
// Work that keeps a Session from accepting a new round. Non-user next-step context (for example a
// background-subagent failure notice) never starts a turn on an idle Agent, so it must not block.
const blocking = agent => [...agent.inbox.nextTurn, ...agent.inbox.nextStep.filter(m => m.source?.kind === 'user')];
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

/** Text of the newest ask_user_question call in session events ('' when it cannot be found). */
export function askedQuestion(events = []) {
  const isAsk = node => node && typeof node === 'object' && [node.name, node.toolName, node.tool].includes('ask_user_question');
  const find = (node, depth = 0) => {
    if (!node || typeof node !== 'object' || depth > 6) return null;
    if (isAsk(node)) return node;
    for (const value of Array.isArray(node) ? node : Object.values(node)) { const hit = find(value, depth + 1); if (hit) return hit; }
    return null;
  };
  for (let i = events.length - 1; i >= 0; i--) {
    const call = find(events[i]?.data);
    if (!call) continue;
    let input = call.input ?? call.args ?? call.arguments ?? call.params;
    if (typeof input === 'string') { try { input = JSON.parse(input); } catch { input = {}; } }
    const questions = (input?.questions || []).map(q => [q?.header, q?.question].filter(v => typeof v === 'string' && v.trim()).join('：')).filter(Boolean);
    return questions.join('\n').slice(0, 2000);
  }
  return '';
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

  /**
   * Prompt-side context size of the session's next request, or null when unknown. Prefers DSH's own
   * token-meter projection (`contextPressure`: input + cache read + cache write of the newest model call,
   * adjusted for later compaction); falls back to the newest `usage` sample in durable history.
   */
  async contextTokens(sessionId) {
    const controller = this.ctx.sessionController;
    if (typeof controller?.projections === 'function') {
      try {
        const projected = await controller.projections({ sessionId }, new AbortController().signal);
        const pressure = projected?.values?.contextPressure;
        const tokens = pressure?.projectedTokens ?? pressure?.pressureTokens;
        if (Number.isFinite(tokens)) return tokens;
      } catch { /* fall back to history */ }
    }
    const usage = (await this.inspect(sessionId)).events
      .findLast(e => e.type === 'assistant/message' && e.data?.usage)?.data.usage;
    if (!usage) return null;
    const tokens = (usage.inputTokens || 0) + (usage.cacheReadTokens || 0) + (usage.cacheWriteTokens || 0);
    return Number.isFinite(tokens) ? tokens : null;
  }

  /** The session's working directory: from its header when available, else from the session list. */
  async cwd(sessionId, inspection) {
    if (inspection?.meta?.cwd) return inspection.meta.cwd;
    const controller = this.ctx.sessionController;
    if (typeof controller.list !== 'function') return inspection?.meta?.cwd;
    const listed = await controller.list({}, new AbortController().signal);
    return listed?.items?.find(item => item.sessionId === sessionId)?.cwd;
  }

  /**
   * The Workspace registered for a project directory, registering it when missing, so dispatched
   * sessions appear under the project in the sidebar instead of "ungrouped". Grouping is cosmetic:
   * any registry failure falls back to a plain cwd session.
   */
  async workspace(cwd) {
    const registry = this.ctx.workspaceRegistry;
    if (typeof registry?.resolveByPath !== 'function') return undefined;
    // Starts run in parallel: tasks of one project share the in-flight lookup, so a missing Workspace is
    // registered once, not once per task.
    this.workspaces ||= new Map();
    const key = path.resolve(cwd);
    if (!this.workspaces.has(key)) {
      const lookup = (async () => {
        try { return (await registry.resolveByPath(cwd)) ?? (typeof registry.create === 'function' ? await registry.create(cwd) : undefined); }
        catch { return undefined; }
      })();
      this.workspaces.set(key, lookup);
      lookup.finally(() => this.workspaces.delete(key));
    }
    return this.workspaces.get(key);
  }

  /**
   * Session-level reasoning effort for the experiment: records a model/selection on the Agent (provider/model
   * from its current selection, else the configured fallback). Never the session/selectModel RPC, which also
   * rewrites the profile default. A failure is reported, never blocks the round.
   */
  async selectEffort(sessionId, effort, agent) {
    try {
      agent ??= (await this.ctx.sessionController.resolveAgent(sessionId))?.agent;
      if (typeof agent?.model?.select !== 'function') throw new Error('Session model selection unavailable');
      let current;
      try { current = agent.model.current?.(); } catch { /* use the fallback route */ }
      const provider = current?.provider || effort.provider, model = current?.model || effort.model;
      await agent.model.select({ provider, model, reasoningEffort: effort.effort });
      return { effort: effort.effort, arm: effort.arm, provider, model };
    } catch (error) {
      return { effort: effort.effort, arm: effort.arm, error: error?.message || String(error) };
    }
  }

  async start({ task, attempt, effort }) {
    const controller = this.ctx.sessionController;
    if (!controller) return { status: 'rejected', reason: 'DSH session service unavailable' };
    const workspace = await this.workspace(task.cwd);
    let resolved;
    if (attempt.resume) {
      const inspection = await this.inspect(attempt.sessionId);
      if (path.resolve((await this.cwd(attempt.sessionId, inspection)) || '') !== path.resolve(task.cwd))
        return { status: 'rejected', reason: 'Session directory differs from project' };
      resolved = await controller.resolveAgent(attempt.sessionId);
      if (resolved.error) return { status: 'busy', reason: 'Session writer unavailable' };
      if (resolved.agent.status !== 'idle' || blocking(resolved.agent).length)
        return { status: 'busy', reason: 'Session already has active or queued work' };
      // Sessions created before Workspace attachment existed are attached on their next round.
      if (typeof workspace?.attachSession === 'function') await workspace.attachSession(attempt.sessionId).catch(() => {});
    } else {
      const created = await controller.create({ sessionId: attempt.sessionId,
        ...(workspace?.id ? { workspaceId: workspace.id } : { cwd: task.cwd }),
        ...(this.config.preset ? { agentPreset: this.config.preset } : {}) });
      // Do not lose a changed identity across a crash before receipt persistence.
      if (created.sessionId !== attempt.sessionId)
        return { status: 'rejected', reason: 'Requested session identity could not be reserved' };
    }
    const selected = effort ? await this.selectEffort(attempt.sessionId, effort, resolved?.agent) : undefined;
    await controller.prompt({ sessionId: attempt.sessionId, requestId: attempt.id,
      mode: 'queue', content: [{ type: 'text', text: task.prompt }] }, new AbortController().signal);
    return { status: 'running', sessionId: attempt.sessionId, runId: attempt.id, ...(selected ? { effort: selected } : {}) };
  }
  async reconcile({ attempt }) {
    const agent = this.ctx.agents?.get(attempt.sessionId);
    // A detached Agent is not in memory; let start() re-resolve it instead of waiting forever.
    if (attempt.status === 'busy') return { status: !agent || (agent.status === 'idle' && !blocking(agent).length) ? 'ready' : 'busy' };
    // Cheap answers first: reading the whole session history every pass for every running task was the bulk of
    // a reconcile. The prompt still queued in the live inbox proves admission; a live running Agent whose
    // admission this adapter already confirmed is still on the round.
    this.admitted ||= new Set();
    if (agent && pending(agent).some(m => belongs(m, attempt))) return { status: 'running' };
    if (agent?.status === 'running' && this.admitted.has(attempt.id)) return (await this.waitingForAnswer(attempt, agent)) || { status: 'running' };
    const inspection = await this.inspect(attempt.sessionId);
    const events = inspection.events;
    const index = events.findIndex(event => event.type === 'agent/inbox/spliced'
      && event.data.inserted?.some(message => belongs(message, attempt)));
    if (index < 0) return { status: 'unknown', reason: 'Prompt admission not found in durable history' };
    if (this.admitted.size > 2000) this.admitted.clear();
    this.admitted.add(attempt.id);
    if (agent?.status === 'running') return (await this.waitingForAnswer(attempt, agent, events)) || { status: 'running' };
    const suffix = events.slice(index);
    const endIndex = suffix.findIndex(event => event.type === 'turn/end');
    const end = suffix[endIndex];
    if (!end) return { status: 'unknown', reason: 'No confirmed turn completion' };
    this.admitted.delete(attempt.id);
    // A later manual/queued turn in the same session is not this attempt's receipt.
    const message = suffix.slice(0, endIndex).findLast(event => event.type === 'assistant/message');
    const content = message?.data?.message?.content ?? message?.data?.content ?? [];
    return { status: end.data.reason.kind === 'completed' ? 'review' : 'failed',
      reason: end.data.reason.kind,
      summary: Array.isArray(content) ? captureResultText(content.filter(p => p.type === 'text').map(p => p.text).join('\n')) : '' };
  }
  /**
   * An unattended round that called ask_user_question waits for an answer nobody gives (DSH session/state reports
   * pendingInput 'question'). Such a round is not running: its turn is cancelled so the session becomes idle
   * again (an answer continues it later in the same session) and the result is { status: 'needs_input' } with the
   * question. Returns null while the round is really working. Approvals and other inputs are left alone.
   */
  async waitingForAnswer(attempt, agent, events) {
    const controller = this.ctx.sessionController;
    if (typeof controller?.state !== 'function') return null;
    let state;
    try { state = await controller.state({ sessionId: attempt.sessionId }, new AbortController().signal); } catch { return null; }
    if (!Array.isArray(state?.pendingInput) || !state.pendingInput.includes('question')) return null;
    if (!events) { try { events = (await this.inspect(attempt.sessionId)).events; } catch { events = []; } }
    const question = askedQuestion(events);
    let cancelled = false;
    try {
      agent.cancel({ kind: 'user' }, { keepInbox: true });
      let timer;
      cancelled = await Promise.race([agent.whenIdle().then(() => true), new Promise(r => { timer = setTimeout(() => r(false), 5000); })]);
      clearTimeout(timer);
    } catch { /* the round is reported as waiting for input either way */ }
    this.admitted.delete(attempt.id);
    return { status: 'needs_input', reason: 'question', question, cancelled };
  }
  async idle({ attempt }) {
    const agent = this.ctx.agents?.get(attempt.sessionId);
    if (agent) return agent.status === 'idle' && blocking(agent).length === 0;
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
