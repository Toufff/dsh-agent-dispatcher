import { z } from 'zod';
import path from 'node:path';

const id = z.string().min(1).max(160);
export const executorSchema = z.object({
  id, label: id, type: z.string().regex(/^[a-z][a-z0-9-]*$/), enabled: z.boolean(),
  command: z.string().optional(), args: z.array(z.string()).default([]),
  preset: z.string().optional(), sandbox: z.enum(['read-only', 'workspace-write']).default('workspace-write'),
  verified: z.boolean().default(false)
}).strict();
export const projectSchema = z.object({
  id, label: id, cwd: z.string().refine(path.isAbsolute, 'Use an absolute local directory'),
  category: z.enum(['business', 'test', 'archive']).optional(),
  executionInstructions: z.string().max(6000).optional(),
  followup: z.object({ enabled: z.boolean(), commentAuthorIds: z.array(id).max(30),
    observeAfterExpiry: z.boolean().optional(),
    maxWakeups: z.number().int().min(1).max(50).default(8) }).strict().optional(),
  linear: z.object({ workspaceId: id, projectId: id, assigneeId: id, readyStateId: id,
    reviewStateId: id, activeStateId: id.optional(), blockedStateId: id.optional(), tokenEnv: z.string().regex(/^[A-Z][A-Z0-9_]+$/),
    enabled: z.boolean().default(false), shareProgress: z.boolean().optional(), since: z.string().datetime(),
    round: id.default('1') }).strict().optional()
}).strict();
export const notificationChannelSchema = z.object({
  id, type: z.literal('feishu'), label: id, enabled: z.boolean(),
  credentialsFile: z.string().refine(path.isAbsolute, 'Use an absolute private credential file'),
  projectIds: z.array(id).min(1).max(100),
  includeExisting: z.boolean().default(false), completed: z.boolean().default(false)
}).strict();
export const settingsSchema = z.object({ executors: z.array(executorSchema), projects: z.array(projectSchema),
  notifications: z.object({ channels: z.array(notificationChannelSchema).max(10) }).strict().optional() })
  .strict().superRefine((value, ctx) => {
    for (const key of ['executors', 'projects']) {
      if (new Set(value[key].map(v => v.id)).size !== value[key].length)
        ctx.addIssue({ code: 'custom', message: `Duplicate ${key} identity` });
    }
    const channels = value.notifications?.channels || [];
    if (new Set(channels.map(c => c.id)).size !== channels.length)
      ctx.addIssue({ code: 'custom', message: 'Duplicate notification channel identity' });
    if (channels.some(c => c.projectIds.some(id => !value.projects.some(p => p.id === id))))
      ctx.addIssue({ code: 'custom', message: 'Notification project does not exist' });
  });
export const initialState = () => ({ version: 1, revision: 0, paused: true, tasks: [], outbox: [],
  settings: { executors: [
    { id: 'codex', label: 'ChatGPT', type: 'codex', command: 'codex', enabled: true, args: [], sandbox: 'workspace-write', verified: false },
    { id: 'dsh', label: 'DSH', type: 'dsh', enabled: true, args: [], sandbox: 'workspace-write', verified: false },
    { id: 'claude', label: 'Claude Code', type: 'claude', command: 'claude', enabled: false, args: [], sandbox: 'workspace-write', verified: false }
  ], projects: [] } });
