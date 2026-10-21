import path from 'node:path';
import { stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Dispatcher } from './dispatcher.js';
import { settingsSchema } from './config.js';
import { CliAdapter } from './adapters/cli.js';
import { DshAdapter } from './adapters/dsh.js';
import { LinearClient } from './linear.js';

export class Runtime {
  constructor({ store, ctx = {}, directory, linearFactory = token => new LinearClient(token), env = process.env }) {
    this.store = store; this.ctx = ctx; this.directory = directory; this.env = env;
    this.linearFactory = linearFactory; this.adapters = {}; this.health = {}; this.errors = [];
    this.dispatcher = new Dispatcher({ store, adapters: this.adapters });
  }
  async init() { const state = await this.store.load(); this.install(state.settings); return this; }
  install(settings) {
    for (const config of settings.executors) {
      const signature = JSON.stringify({ ...config, enabled: true });
      if (this.adapters[config.id]?.signature === signature) continue;
      const adapter = config.type === 'dsh' ? new DshAdapter(this.ctx, config)
        : new CliAdapter(config, path.join(this.directory, 'runs'));
      adapter.signature = signature;
      this.adapters[config.id] = adapter;
    }
  }
  async snapshot() { return { ...await this.store.load(), health: this.health, errors: this.errors }; }
  async configure(settings, revision) {
    settings = settingsSchema.parse(settings);
    await this.dispatcher.update(state => {
      if (revision !== state.revision) throw new Error('Settings changed in another window; refresh first');
      const active = state.tasks.filter(t => !['review', 'accepted', 'failed', 'stopped', 'exhausted'].includes(t.status));
      for (const task of active) {
        if (JSON.stringify(settings.projects.find(p => p.id === task.projectId)) !==
            JSON.stringify(state.settings.projects.find(p => p.id === task.projectId)))
          throw new Error('Stop affected tasks before changing project mappings');
        for (const id of task.executors) {
          const before = state.settings.executors.find(e => e.id === id), after = settings.executors.find(e => e.id === id);
          if (!after || JSON.stringify({ ...before, enabled: true }) !== JSON.stringify({ ...after, enabled: true }))
            throw new Error('Stop affected tasks before changing executor commands');
        }
      }
      state.settings = settings; state.revision++;
    });
    this.install(settings);
  }
  async submit({ projectId, title, prompt, session, source, round, issue }) {
    const state = await this.store.load();
    const project = state.settings.projects.find(p => p.id === projectId);
    if (!project) throw new Error('Select a locally configured project');
    if (!(await stat(project.cwd)).isDirectory()) throw new Error('Project directory does not exist');
    if (session && !state.tasks.some(t => t.cwd === project.cwd && [...t.attempts, ...(t.previousAttempts ?? [])]
      .some(a => a.executor === session.executor && a.sessionId === session.id)))
      throw new Error('Only a registered task session can be resumed');
    const executors = state.settings.executors.filter(e => e.enabled).map(e => e.id);
    return this.dispatcher.enqueue({ projectId, title, prompt, session, issue, cwd: project.cwd, executors,
      source: source ?? `local:${randomUUID()}`, round: round ?? '1' });
  }
  async command(request) {
    if (request.action === 'configure') await this.configure(request.settings, request.revision);
    else if (request.action === 'submit') await this.submit(request);
    else if (request.action === 'pause' || request.action === 'resume')
      await this.dispatcher.update(state => { state.paused = request.action === 'pause'; });
    else if (request.action === 'reconcile') await this.dispatcher.reconcile();
    else if (request.action === 'poll') await this.intake();
    else await this.dispatcher.action(request.id, request.action, request);
    return this.snapshot();
  }
  client(mapping) {
    const token = this.env[mapping.tokenEnv];
    if (!token) throw new Error(`Missing environment variable ${mapping.tokenEnv}`);
    return this.linearFactory(token);
  }
  async intake() {
    const state = await this.store.load();
    for (const project of state.settings.projects.filter(p => p.linear?.enabled)) {
      const client = this.client(project.linear);
      for (const issue of await client.issues(project.linear)) {
        await this.submit({ projectId: project.id, title: `${issue.identifier} · ${issue.title}`,
          prompt: `${issue.title}\n\n${issue.description ?? ''}\n\nReturn a concise implementation and verification summary.`,
          source: `${project.linear.workspaceId}/${issue.id}`, round: project.linear.round,
          issue: { id: issue.id, url: issue.url, identifier: issue.identifier } });
      }
    }
  }
  async report() {
    await this.dispatcher.update(state => {
      for (const task of state.tasks.filter(t => ['review', 'accepted'].includes(t.status) && t.issue && t.report === 'pending')) {
        state.outbox.push({ id: randomUUID(), taskId: task.id, projectId: task.projectId,
          issueId: task.issue.id, stateId: state.settings.projects.find(p => p.id === task.projectId)?.linear?.reviewStateId,
          // Fixed report intentionally excludes local output, names, paths and session IDs.
          body: 'Agent execution finished and is ready for human review. Completion is not acceptance. Review the implementation and verification evidence with the recipient.',
          status: 'pending', tries: 0 });
        task.report = 'queued';
      }
    });
    const state = await this.store.load();
    for (const item of state.outbox.filter(i => i.status === 'pending' && (!i.nextAt || i.nextAt <= Date.now()))) {
      const project = state.settings.projects.find(p => p.id === item.projectId);
      try {
        await this.client(project.linear).report(item);
        await this.dispatcher.update(s => {
          s.outbox.find(i => i.id === item.id).status = 'sent';
          s.tasks.find(t => t.id === item.taskId).report = 'sent';
        });
      } catch {
        await this.dispatcher.update(s => {
          const entry = s.outbox.find(i => i.id === item.id); entry.tries++;
          entry.nextAt = Date.now() + Math.min(300000, 5000 * 2 ** Math.min(entry.tries, 6));
        });
      }
    }
  }
  async cycle() {
    if (this.cycling) return;
    this.cycling = true;
    try {
      await this.dispatcher.reconcile(); await this.dispatcher.tick(); await this.report();
      for (const [id, adapter] of Object.entries(this.adapters)) this.health[id] = await adapter.health();
      if (Date.now() - (this.lastPoll ?? 0) > 30000) { this.lastPoll = Date.now(); await this.intake(); }
      this.errors = [];
    } catch (error) { this.errors = [String(error.message).slice(0, 300)]; }
    finally { this.cycling = false; }
  }
}
