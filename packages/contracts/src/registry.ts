import { z } from 'zod';
const variable = z.object({
  description: z.string().optional(),
  default: z.string().optional(),
  choices: z.array(z.string()).optional(),
  isRequired: z.boolean().optional(),
  isSecret: z.boolean().optional(),
  format: z.string().optional(),
});
export const registryInputField = variable.extend({
  name: z.string().optional(),
  value: z.string().optional(),
  valueHint: z.string().optional(),
  type: z.enum(['positional', 'named']).optional(),
  isRepeated: z.boolean().optional(),
  variables: z.record(z.string(), variable).optional(),
});
const transport = z.object({ type: z.string(), url: z.string().optional() });
export const registryPackage = z.object({
  registryType: z.string(),
  registryBaseUrl: z.url().optional(),
  identifier: z.string(),
  version: z.string().optional(),
  runtimeHint: z.string().optional(),
  transport,
  runtimeArguments: z.array(registryInputField).default([]),
  packageArguments: z.array(registryInputField).default([]),
  environmentVariables: z.array(registryInputField).default([]),
});
export const registryRemote = transport.extend({
  headers: z.array(registryInputField).default([]),
  variables: z.record(z.string(), variable).default({}),
});
export const registryServer = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  description: z.string(),
  title: z.string().optional(),
  websiteUrl: z.url({ protocol: /^https?$/ }).optional(),
  repository: z.object({ url: z.url().optional(), source: z.string().optional() }).optional(),
  packages: z.array(registryPackage).default([]),
  remotes: z.array(registryRemote).default([]),
});
export const registryRecord = z.object({
  server: registryServer,
  _meta: z.record(z.string(), z.unknown()).optional(),
});
export const registryPage = z.object({
  servers: z.array(registryRecord),
  metadata: z
    .object({ nextCursor: z.string().optional(), count: z.number().optional() })
    .default({}),
});
export const marketSelection = z
  .object({
    serverName: z.string().min(1),
    version: z.string().min(1),
    distribution: z.enum(['package', 'remote']),
    index: z.number().int().nonnegative(),
    name: z.string().min(1),
    adapter: z.enum(['direct', 'pi', 'device']),
    deviceId: z.uuid().optional(),
    executable: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/)
      .optional(),
    values: z.record(z.string(), z.union([z.string(), z.array(z.string())])).default({}),
    previewHash: z.string().optional(),
  })
  .strict();
export type RegistryServer = z.infer<typeof registryServer>;
export type RegistryPackage = z.infer<typeof registryPackage>;
export type RegistryRemote = z.infer<typeof registryRemote>;
export type RegistryInputField = z.infer<typeof registryInputField>;
export type MarketSelection = z.infer<typeof marketSelection>;
