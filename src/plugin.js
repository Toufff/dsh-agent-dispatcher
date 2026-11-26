import path from 'node:path';
import os from 'node:os';
import { Service } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { initialState } from './config.js';
import { acquireLease } from './store.js';
import { RecordDomainBackend, openTaskDomain, TASK_DOMAIN, LEGACY_DOMAIN } from './migration.js';
import { TaskStore } from './state-store.js';
import { ArchiveStore } from './archive.js';
import { archivePlan, archivePolicy, applyArchive } from './archiving.js';
import { Runtime } from './runtime.js';
import { remote } from './remote.js';

/** Legacy single-document state (read once by the migration; also the export format of the rollback script). */
export const domainSpec = defineDomain({ name: LEGACY_DOMAIN, version: 1, tables: {},
  global: { schema: z.object({ version: z.literal(1), tasks: z.array(z.json()), settings: z.json(),
    paused: z.boolean(), revision: z.number(), outbox: z.array(z.json()), notifications: z.json().optional(), linearSync: z.record(z.string(), z.json()).optional() }), initial: initialState() } });
/** Current state: one document per task and outbox item; small global document (see RecordDomainBackend). */
export const taskDomainSpec = defineDomain({ name: TASK_DOMAIN, version: 1, layout: 'per-record',
  tables: { tasks: domainTable(z.json()), outbox: domainTable(z.json()) },
  global: { schema: z.record(z.string(), z.json()), initial: {} } });

/** Where the JSON storage backend keeps unit files (to back up the legacy document next to itself). */
function storageRoots(ctx) {
  const roots = [];
  try { roots.push(ctx.storage?.backend?.get?.('json')?.root); } catch { /* backend not reachable from this plugin */ }
  roots.push(path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'storages'));
  return roots;
}

export default class AgentDispatcher extends TypertRemoteService {
  // workspaceRegistry: dispatched sessions are attached to the project's Workspace so the UI groups them.
  static inject = ['storageDomain', 'sessionController', 'agents', 'typert', 'workspaceRegistry'];
  static Config = Schema.object({ directory: Schema.string().description('Private runtime receipt directory (outside the source repository)') });
  constructor(ctx, config = {}) {
    super(ctx, 'agentDispatcher');
    const directory = config.directory || path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'agent-dispatcher');
    const leaseLog = message => { try { ctx.logger?.('agent-dispatcher')?.warn?.(message); } catch { /* logging is optional */ } };
    this.ready = acquireLease(directory, { log: leaseLog }).then(async release => {
      this.release = release;
      const log = message => { try { ctx.logger?.('agent-dispatcher')?.warn?.(message); } catch { /* logging is optional */ } };
      const archive = await new ArchiveStore(path.join(directory, 'archive')).open();
      // The migration moves history straight to the archive, so only the hot records are written as documents.
      // Finished write-backs without a finish time are legacy: only their ids matter afterwards (kept).
      const prepare = async state => { const now = Date.now();
        await applyArchive(state, archive, archivePlan(state, archivePolicy(state.settings), now, { unstampedOutbox: 'archive' }), now); return state; };
      const domain = await openTaskDomain({ open: spec => ctx.storageDomain.open(spec), spec: taskDomainSpec, legacySpec: domainSpec,
        isFresh: value => isDeepStrictEqual(value, domainSpec.global.initial), backupCandidates: storageRoots(ctx), directory, prepare, log });
      this.domain = domain;
      const store = await new TaskStore(new RecordDomainBackend(domain), { archive, log }).open();
      this.runtime = await new Runtime({ ctx, store, directory }).init();
      return this.runtime;
    });
    ctx.effect(() => ctx.typert.register({ package: 'dsh-agent-dispatcher', face: 'host', schemas: [],
      invocations: remote.descriptors, model: { services: [], events: [], objects: [] } }));
    ctx.effect(() => {
      const timer = setInterval(() => this.ready.then(r => r.cycle()).catch(() => {}), 1500);
      return async () => { clearInterval(timer); await this.ready.catch(() => {});
        while (this.runtime?.cycling) await new Promise(r => setTimeout(r, 100));
        await this.runtime?.notifications.pending?.catch(() => {});
        await this.domain?.close(); await this.release?.(); };
    });
  }
  async [Service.init]() { await this.ready; }
  owner() {
    const principal = this.ctx.invocation?.peer.principal;
    if (principal && principal.kind !== 'owner') throw new Error('Dispatcher access is restricted to the host owner');
  }
  async snapshot() { this.owner(); return (await this.ready).snapshot(); }
  async command(request) { this.owner(); return (await this.ready).command(request); }
}
