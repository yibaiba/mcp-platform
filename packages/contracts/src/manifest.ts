import { resultPresentation } from './resultPresentation.js';
import { embeddingConfig, searchOptions } from './discovery.js';
import { z } from 'zod';
const logicalName = z.string().regex(/^[\p{L}\p{N}][\p{L}\p{N}_. @-]*$/u);
const tool = z
  .object({
    connection: logicalName,
    name: z.string().min(1),
    alias: z
      .string()
      .regex(/^[A-Za-z0-9_.-]+$/)
      .optional(),
    description: z.string().optional(),
    hiddenParameters: z.array(z.string().min(1)).default([]),
  })
  .strict();
const content = z
  .object({
    connection: logicalName,
    kind: z.enum(['prompt', 'resource', 'template']),
    locator: z.string().min(1),
    description: z.string().optional(),
  })
  .strict();
const capabilities = z
  .object({
    tools: z.array(tool).default([]),
    content: z.array(content).default([]),
    artifacts: z.array(logicalName).default([]),
  })
  .strict();
export const manifestProfile = capabilities.extend({
  name: z.string().min(1),
  instructions: z.string().default(''),
  discoveryMode: z.enum(['direct', 'search']).default('direct'),
  embedding: embeddingConfig.nullable().default(null),
  resultPresentation: resultPresentation.default(() => resultPresentation.parse({})),
  searchOptions: searchOptions.default(() => searchOptions.parse({})),
  pinnedTools: z.array(tool.pick({ connection: true, name: true })).default([]),
  skills: z.array(logicalName).default([]),
  requestable: capabilities.default(() => capabilities.parse({})),
  toolNaming: z.enum(['stable', 'original', 'prefixed']).default('stable'),
  connectionAliases: z.record(logicalName, logicalName).default({}),
  connectionIdentities: z
    .record(logicalName, z.enum(['inherit', 'profile', 'credential']))
    .default({}),
});
export const manifestConnection = z.union([
  z
    .object({
      config: z.record(z.string(), z.unknown()),
      deviceRef: logicalName.optional(),
    })
    .strict(),
  z.object({ sharedRef: logicalName }).strict(),
]);
export const configManifest = z
  .object({
    version: z.literal(1),
    name: logicalName,
    connections: z.record(logicalName, manifestConnection).default({}),
    profiles: z.record(logicalName, manifestProfile).default({}),
    shares: z
      .record(
        logicalName,
        z
          .object({
            connection: logicalName,
            recipientRef: logicalName,
            credentialMode: z.enum(['independent', 'owner']).default('independent'),
            tools: z.array(z.string().min(1)).default([]),
            content: z.array(content.omit({ connection: true, description: true })).default([]),
          })
          .strict(),
      )
      .default({}),
  })
  .strict();
export const manifestMappings = z
  .object({
    devices: z.record(logicalName, z.uuid()).default({}),
    shares: z.record(logicalName, z.uuid()).default({}),
    users: z.record(logicalName, z.string().min(1)).default({}),
    skills: z.record(logicalName, z.uuid()).default({}),
    artifacts: z.record(logicalName, z.uuid()).default({}),
    directories: z.record(logicalName, z.string().min(1)).default({}),
  })
  .strict();
export const manifestApply = z
  .object({
    declaration: configManifest,
    mappings: manifestMappings.default(() => manifestMappings.parse({})),
    mode: z.enum(['upsert', 'prune']).default('upsert'),
    revision: z.number().int().positive().optional(),
  })
  .strict();
export type ConfigManifest = z.infer<typeof configManifest>;
export type ManifestMappings = z.infer<typeof manifestMappings>;
export type ManifestProfile = z.infer<typeof manifestProfile>;
export type ManifestConnection = z.infer<typeof manifestConnection>;
export type ManifestApply = z.infer<typeof manifestApply>;
