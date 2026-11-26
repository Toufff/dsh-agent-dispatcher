import { z } from 'zod';
import { waitSchema } from './followup.js';
import { createTypertRemoteInfo } from '@deepseek-ai/dsh-typert-protocol/remote-info';

const codec = (schema, name) => ({ mode: 'strict', typeSymbol: `dsh-agent-dispatcher#${name}`, create: () => schema });
const commandSchema = z.object({ action: z.enum(['configure', 'submit', 'pause', 'resume', 'poll', 'reconcile',
  'stop', 'takeover', 'return', 'retry', 'accept', 'continue', 'arm-wait', 'reassess-result', 'issue-context', 'archived-task', 'linear-catalog', 'check-directory',
  'unhold', 'clear-resume', 'explain', 'drain', 'undrain',
  'focus-set', 'focus-add', 'focus-remove', 'focus-clear', 'focus-approve', 'focus-reject',
  // Linear merged exit (src/linear-outbox.js): local scripts write through the outbox and read the sync cache.
  'linear-enqueue', 'linear-result', 'linear-view']), id: z.string().optional(),
  caller: z.enum(['director', 'push-queue', 'ops']).optional(), idempotencyKey: z.string().min(1).max(200).optional(), op: z.json().optional(),
  ids: z.array(z.string().max(80)).max(500).optional(), since: z.string().max(40).optional(),
  include: z.array(z.enum(['issues', 'comments'])).max(2).optional(), settings: z.json().optional(), wait: waitSchema.optional(),
  tokenEnv: z.string().regex(/^[A-Z][A-Z0-9_]+$/).max(160).optional(), cwd: z.string().max(4096).optional(),
  revision: z.number().optional(), confirmedIdle: z.boolean().optional(), preserveCursor: z.boolean().optional(), expiry: z.boolean().optional(), reason: z.string().max(300).optional(), projectId: z.string().optional(), title: z.string().max(300).optional(),
  prompt: z.string().min(1).max(100000).optional(),
  issues: z.array(z.string().max(40)).max(200).optional(), issue: z.string().max(40).optional(), intent: z.string().max(2000).optional(),
  continuationTiming: z.enum(['inherit', 'recheck']).optional(),
  session: z.object({ executor: z.string(), id: z.string() }).optional() }).strict();
export const remote = createTypertRemoteInfo({ package: 'dsh-agent-dispatcher', methods: {
  'agentDispatcher/snapshot': { service: 'agentDispatcher', invocation: { kind: 'direct' }, parameters: [],
    result: codec(z.json(), 'snapshot') },
  'agentDispatcher/command': { service: 'agentDispatcher', invocation: { kind: 'direct' },
    parameters: [{ name: 'request', source: 'json', codec: codec(commandSchema, 'command'), strictCodec: codec(commandSchema, 'command') }],
    result: codec(z.json(), 'command-result') }
} }, z);
export default remote;
