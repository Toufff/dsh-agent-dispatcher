import path from 'node:path';
import os from 'node:os';
import { Service } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { defineDomain } from '@deepseek-ai/dsh-storage-domain';
import { z } from 'zod';
import { initialState } from './config.js';
import { DomainStore, acquireLease } from './store.js';
import { Runtime } from './runtime.js';
import { remote } from './remote.js';

export const domainSpec = defineDomain({ name: 'agent_dispatcher', version: 1, tables: {},
  global: { schema: z.object({ version: z.literal(1), tasks: z.array(z.json()), settings: z.json(),
    paused: z.boolean(), revision: z.number(), outbox: z.array(z.json()), notifications: z.json().optional(), linearSync: z.record(z.string(), z.json()).optional() }), initial: initialState() } });

export default class AgentDispatcher extends TypertRemoteService {
  static inject = ['storageDomain', 'sessionController', 'agents', 'typert'];
  static Config = Schema.object({ directory: Schema.string().description('Private runtime receipt directory (outside the source repository)') });
  constructor(ctx, config = {}) {
    super(ctx, 'agentDispatcher');
    const directory = config.directory || path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'agent-dispatcher');
    this.ready = acquireLease(directory).then(async release => {
      this.release = release;
      const domain = await ctx.storageDomain.open(domainSpec);
      this.domain = domain;
      this.runtime = await new Runtime({ ctx, store: new DomainStore(domain),
        directory }).init();
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
