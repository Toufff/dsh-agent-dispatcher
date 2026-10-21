import path from 'node:path';
import os from 'node:os';
import { Service } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { defineDomain } from '@deepseek-ai/dsh-storage-domain';
import { z } from 'zod';
import { initialState } from './config.js';
import { DomainStore } from './store.js';
import { Runtime } from './runtime.js';
import { remote } from './remote.js';

export const domainSpec = defineDomain({ name: 'agent-dispatcher', version: 1, tables: {},
  global: { schema: z.object({ version: z.literal(1), tasks: z.array(z.json()), settings: z.json(),
    paused: z.boolean(), revision: z.number(), outbox: z.array(z.json()) }), initial: initialState() } });

export default class AgentDispatcher extends TypertRemoteService {
  static inject = ['storageDomain', 'sessionController', 'agents', 'typert'];
  static Config = Schema.object({ directory: Schema.string().description('Private runtime receipt directory (outside the source repository)') });
  constructor(ctx, config = {}) {
    super(ctx, 'agentDispatcher');
    this.ready = ctx.storageDomain.open(domainSpec).then(async domain => {
      this.domain = domain;
      this.runtime = await new Runtime({ ctx, store: new DomainStore(domain),
        directory: config.directory || path.join(os.homedir(), '.dsh', 'agent-dispatcher') }).init();
      return this.runtime;
    });
    ctx.effect(() => ctx.typert.remotes.register(remote));
    ctx.effect(() => {
      const timer = setInterval(() => this.ready.then(r => r.cycle()).catch(() => {}), 1500);
      return async () => { clearInterval(timer); await this.ready.catch(() => {});
        while (this.runtime?.cycling) await new Promise(r => setTimeout(r, 100));
        await this.domain?.close(); };
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
