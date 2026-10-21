import { z } from 'zod';
import { createTypertRemoteInfo } from '@deepseek-ai/dsh-typert-protocol';

const codec = (schema, name) => ({ mode: 'strict', typeSymbol: `dsh-agent-dispatcher#${name}`, create: () => schema });
const commandSchema = z.object({ action: z.enum(['configure', 'submit', 'pause', 'resume', 'poll', 'reconcile',
  'stop', 'takeover', 'return', 'retry', 'accept']), id: z.string().optional(), settings: z.json().optional(),
  revision: z.number().optional(), projectId: z.string().optional(), title: z.string().max(300).optional(),
  prompt: z.string().min(1).max(100000).optional(),
  session: z.object({ executor: z.string(), id: z.string() }).optional() }).strict();
export const remote = createTypertRemoteInfo({ package: 'dsh-agent-dispatcher', methods: {
  'agentDispatcher/snapshot': { service: 'agentDispatcher', invocation: { kind: 'direct' }, parameters: [],
    result: codec(z.json(), 'snapshot') },
  'agentDispatcher/command': { service: 'agentDispatcher', invocation: { kind: 'direct' },
    parameters: [{ name: 'request', source: 'json', codec: codec(commandSchema, 'command'), strictCodec: codec(commandSchema, 'command') }],
    result: codec(z.json(), 'command-result') }
} }, z);
export default remote;
