import { z } from 'zod';

export const localClient = z.enum(['cursor', 'claude', 'codex', 'pi']);
export const localSource = z
  .object({
    id: z.string(),
    client: localClient,
    kind: z.enum(['mcp', 'skill']),
    path: z.string().min(1),
    format: z.enum(['json', 'jsonc', 'toml']),
    project: z.string().optional(),
    pointer: z.array(z.string()).optional(),
    readOnly: z.boolean(),
  })
  .strict();
export const localResource = z
  .object({
    id: z.string(),
    kind: z.enum(['mcp', 'skill']),
    name: z.string(),
    description: z.string(),
    sourceIds: z.array(z.string()),
    clients: z.array(localClient),
    project: z.string().optional(),
    path: z.string(),
    realPath: z.string(),
    pointer: z.array(z.string()).nullable().optional(),
    digest: z.string(),
    fileDigest: z.string(),
    content: z.record(z.string(), z.unknown()).nullable(),
    readOnly: z.boolean(),
    deleted: z.boolean(),
    selected: z.boolean(),
    reloadRequired: z.boolean(),
    loadedVerified: z.boolean(),
    programExists: z.boolean(),
    runtime: z.string(),
    issues: z.array(z.string()),
  })
  .strict();
export const localOperation = z
  .object({
    id: z.string(),
    action: z.string(),
    resourceId: z.string().optional(),
    requestDigest: z.string(),
    phase: z.string(),
    error: z.string().optional(),
    createdAt: z.string(),
    result: z.unknown().optional(),
    backup: z.string().optional(),
    beforeDigest: z.string().optional(),
    afterDigest: z.string().optional(),
    target: z.string().optional(),
    staged: z.string().optional(),
  })
  .strict();
export const localState = z
  .object({
    initialized: z.boolean().optional(),
    syncTarget: z.string().optional(),
    identityResources: z.record(z.string(), z.string()).default({}),
    revision: z.number().int().positive(),
    sources: z.array(localSource),
    resources: z.record(z.string(), localResource),
    operations: z.record(z.string(), localOperation),
    issues: z.array(z.string()),
  })
  .strict();
export const localRequest = z
  .object({
    action: z.enum([
      'state',
      'resource',
      'operation',
      'backup',
      'scan',
      'project.add',
      'source.add',
      'source.remove',
      'select',
      'edit',
      'delete',
      'restore',
      'start',
      'stop',
      'identity.bind',
    ]),
    id: z.string().optional(),
    identity: z.string().optional(),
    operationId: z.string().min(1).optional(),
    expectedRevision: z.number().int().positive().optional(),
    expectedDigest: z.string().optional(),
    content: z.unknown().optional(),
    source: localSource.optional(),
    project: z.string().optional(),
    confirm: z.boolean().optional(),
    selected: z.boolean().optional(),
  })
  .strict();
export type LocalSource = z.infer<typeof localSource>;
export type LocalResource = z.infer<typeof localResource>;
export type LocalOperation = z.infer<typeof localOperation>;
export type LocalState = z.infer<typeof localState>;
export type LocalRequest = z.infer<typeof localRequest>;
export type LocalBinding = {
  authorizedProfiles?: string[];
  id: string;
  deviceId: string;
  resourceId: string;
  revision: number;
  status: string;
  baseline: LocalResource['content'];
  content: LocalResource['content'];
  localContent?: LocalResource['content'];
  localDigest: string;
  connectionId: string | null;
  skillVersionId: string | null;
  error: string | null;
  deleted: boolean;
  active: boolean;
};

export const localBindingMutation = z
  .object({
    deviceId: z.uuid(),
    id: z.uuid(),
    revision: z.number().int().positive(),
    operationId: z.string().min(1),
    action: z.enum(['update', 'resolve', 'delete', 'unlink']),
    content: z.unknown().optional(),
    choice: z.enum(['local', 'platform', 'merge']).optional(),
    confirm: z.boolean().optional(),
  })
  .strict();
export type LocalBindingMutation = z.infer<typeof localBindingMutation>;
