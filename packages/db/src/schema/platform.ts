import {
  pgTable,
  integer,
  text,
  timestamp,
  jsonb,
  uuid,
  boolean,
  bigint,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { user } from './auth.js';
const owner = () =>
  text('owner_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' });
const created = () => timestamp('created_at', { withTimezone: true }).defaultNow().notNull();
export const devices = pgTable(
  'devices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: owner(),
    name: text('name').notNull(),
    secretEncrypted: text('secret_encrypted'),
    credentialVersion: integer('credential_version').notNull().default(1),
    revoked: boolean('revoked').default(false).notNull(),
    os: text('os'),
    hostname: text('hostname'),
    version: text('version'),
    lastSeen: timestamp('last_seen', { withTimezone: true }),
    services: jsonb('services')
      .$type<{ id: string; status: string; error?: string }[]>()
      .default([])
      .notNull(),
    createdAt: created(),
  },
  (t) => [index('devices_owner').on(t.ownerId)],
);
export const pairings = pgTable('pairings', {
  deviceId: uuid('device_id').references(() => devices.id, { onDelete: 'cascade' }),
  id: uuid('id').primaryKey().defaultRandom(),
  ownerId: owner(),
  name: text('name').notNull(),
  codeHash: text('code_hash').notNull().unique(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
});
export const connections = pgTable(
  'connections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: owner(),
    name: text('name').notNull(),
    adapter: text('adapter').$type<'direct' | 'device' | 'pi'>().notNull(),
    deviceId: uuid('device_id').references(() => devices.id),
    config: text('config').notNull(),
    revision: integer('revision').notNull().default(1),
    status: text('status').notNull().default('disconnected'),
    error: text('error'),
    protocolVersion: text('protocol_version'),
    serverInfo: jsonb('server_info').$type<Record<string, unknown>>(),
    instructions: text('instructions'),
    capabilities: jsonb('capabilities').$type<Record<string, unknown>>().default({}).notNull(),
    createdAt: created(),
  },
  (t) => [index('connections_owner').on(t.ownerId)],
);
export const tools = pgTable(
  'tools',
  {
    id: text('id').primaryKey(),
    ownerId: owner(),
    connectionId: uuid('connection_id')
      .notNull()
      .references(() => connections.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    definition: jsonb('definition').$type<Record<string, unknown>>().notNull(),
    available: boolean('available').notNull().default(true),
  },
  (t) => [
    index('tools_owner').on(t.ownerId),
    uniqueIndex('tools_connection_name').on(t.connectionId, t.name),
  ],
);
export const profiles = pgTable('profiles', {
  deploymentState: text('deployment_state')
    .$type<'pending' | 'ready' | 'error'>()
    .notNull()
    .default('ready'),
  catalog: jsonb('catalog')
    .$type<import('@platform/contracts').CatalogOptions>()
    .notNull()
    .default({ toolNaming: 'stable', connectionAliases: {}, tools: {}, content: {} }),
  id: uuid('id').primaryKey().defaultRandom(),
  ownerId: owner(),
  name: text('name').notNull(),
  instructions: text('instructions').notNull().default(''),
  toolIds: jsonb('tool_ids').$type<string[]>().default([]).notNull(),
  contentIds: jsonb('content_ids').$type<string[]>().default([]).notNull(),
  skillVersionIds: jsonb('skill_version_ids').$type<string[]>().default([]).notNull(),
  artifactIds: jsonb('artifact_ids').$type<string[]>().default([]).notNull(),
  revision: integer('revision').notNull().default(1),
  requestable: jsonb('requestable')
    .$type<import('@platform/contracts').PermissionSet>()
    .notNull()
    .default({ toolIds: [], contentIds: [], artifactIds: [] }),
  connectionIdentities: jsonb('connection_identities')
    .$type<Record<string, 'inherit' | 'profile' | 'credential'>>()
    .notNull()
    .default({}),
  createdAt: created(),
});
export const mcpEntries = pgTable(
  'mcp_entries',
  {
    id: text('id').primaryKey(),
    ownerId: owner(),
    connectionId: uuid('connection_id')
      .notNull()
      .references(() => connections.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<'prompt' | 'resource' | 'template'>().notNull(),
    name: text('name').notNull(),
    locator: text('locator').notNull(),
    definition: jsonb('definition').$type<Record<string, unknown>>().notNull(),
    available: boolean('available').notNull().default(true),
  },
  (t) => [
    index('mcp_entries_owner').on(t.ownerId),
    uniqueIndex('mcp_entries_connection_locator').on(t.connectionId, t.kind, t.locator),
  ],
);
export const accessKeys = pgTable('access_keys', {
  id: uuid('id').primaryKey().defaultRandom(),
  ownerId: owner(),
  profileId: uuid('profile_id')
    .notNull()
    .references(() => profiles.id, { onDelete: 'cascade' }),
  hash: text('hash').notNull().unique(),
  name: text('name').notNull(),
  revoked: boolean('revoked').default(false).notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  createdAt: created(),
});
export const authorizations = pgTable('authorizations', {
  connectionId: uuid('connection_id')
    .primaryKey()
    .references(() => connections.id, { onDelete: 'cascade' }),
  ownerId: owner(),
  encrypted: text('encrypted').notNull(),
  updatedAt: created(),
});
export const calls = pgTable(
  'calls',
  {
    shareId: uuid('share_id'),
    shareVersion: integer('share_version'),
    resourceOwnerId: text('resource_owner_id'),
    credentialOwnerId: text('credential_owner_id'),
    taskId: uuid('task_id'),
    credentialId: text('credential_id'),
    bindingId: text('binding_id'),
    sessionId: text('session_id'),
    entry: text('entry'),
    correlationId: uuid('correlation_id'),
    phase: text('phase').notNull().default('dispatch'),
    revision: integer('revision').notNull().default(1),
    id: uuid('id').primaryKey(),
    ownerId: owner(),
    profileId: uuid('profile_id'),
    toolId: text('tool_id').notNull(),
    connectionId: uuid('connection_id').notNull(),
    deviceId: uuid('device_id'),
    adapter: text('adapter').notNull(),
    status: text('status').notNull(),
    error: text('error'),
    startedAt: created(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
  },
  (t) => [
    index('calls_owner_time').on(t.ownerId, t.startedAt, t.id),
    index('calls_owner_tool_time').on(t.ownerId, t.toolId, t.startedAt, t.id),
    index('calls_owner_connection_time').on(t.ownerId, t.connectionId, t.startedAt, t.id),
    index('calls_owner_device_time').on(t.ownerId, t.deviceId, t.startedAt, t.id),
    index('calls_owner_profile_time').on(t.ownerId, t.profileId, t.startedAt, t.id),
    index('calls_owner_status_time').on(t.ownerId, t.status, t.startedAt, t.id),
  ],
);
export const skillVersions = pgTable(
  'skill_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: owner(),
    name: text('name').notNull(),
    digest: text('digest').notNull(),
    files: jsonb('files').$type<Record<string, string>>().notNull(),
    dependencies: jsonb('dependencies').$type<string[]>().notNull(),
    source: text('source').notNull(),
    revision: text('revision'),
    createdAt: created(),
  },
  (t) => [uniqueIndex('skill_content').on(t.ownerId, t.name, t.digest)],
);
export const installations = pgTable('skill_installations', {
  id: uuid('id').primaryKey().defaultRandom(),
  ownerId: owner(),
  deviceId: uuid('device_id').references(() => devices.id),
  profileId: uuid('profile_id')
    .notNull()
    .references(() => profiles.id),
  versionId: uuid('version_id')
    .notNull()
    .references(() => skillVersions.id),
  target: text('target').notNull(),
  status: text('status').notNull(),
  error: text('error'),
  createdAt: created(),
});
export const artifacts = pgTable('artifacts', {
  taskId: uuid('task_id'),
  profileId: uuid('profile_id'),
  id: uuid('id').primaryKey(),
  ownerId: owner(),
  name: text('name').notNull(),
  sha256: text('sha256').notNull(),
  size: bigint('size', { mode: 'number' }).notNull(),
  createdAt: created(),
});
export const transfers = pgTable('transfers', {
  id: uuid('id').primaryKey().defaultRandom(),
  ownerId: owner(),
  deviceId: uuid('device_id')
    .notNull()
    .references(() => devices.id),
  artifactId: uuid('artifact_id'),
  tokenHash: text('token_hash').notNull().unique(),
  direction: text('direction').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  status: text('status').notNull(),
  error: text('error'),
  createdAt: created(),
});
export const oauthClients = pgTable('oauth_clients', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  redirects: jsonb('redirects').$type<string[]>().notNull(),
});
export const oauthCodes = pgTable('oauth_codes', {
  hash: text('hash').primaryKey(),
  ownerId: owner(),
  clientId: uuid('client_id').notNull(),
  profileId: uuid('profile_id').notNull(),
  redirect: text('redirect').notNull(),
  challenge: text('challenge').notNull(),
  resource: text('resource').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
});
export const oauthGrants = pgTable('oauth_grants', {
  id: uuid('id').primaryKey().defaultRandom(),
  ownerId: owner(),
  clientId: uuid('client_id').notNull(),
  profileId: uuid('profile_id').notNull(),
  accessHash: text('access_hash').notNull().unique(),
  refreshHash: text('refresh_hash').notNull().unique(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  refreshExpiresAt: timestamp('refresh_expires_at', { withTimezone: true }).notNull(),
  revoked: boolean('revoked').notNull().default(false),
  createdAt: created(),
});
export const tasks = pgTable('tasks', {
  revision: integer('revision').notNull().default(1),
  handoffId: uuid('handoff_id'),
  endedAt: timestamp('ended_at', { withTimezone: true }),
  id: uuid('id').primaryKey(),
  ownerId: owner(),
  profileId: uuid('profile_id').notNull(),
  prompt: text('prompt').notNull(),
  status: text('status').notNull(),
  output: text('output').notNull().default(''),
  error: text('error'),
  createdAt: created(),
});

export const authorizationBindings = pgTable(
  'authorization_bindings',
  {
    id: text('id').primaryKey(),
    ownerId: owner(),
    connectionId: uuid('connection_id')
      .notNull()
      .references(() => connections.id, { onDelete: 'cascade' }),
    identity: text('identity').notNull(),
    revision: integer('revision').notNull().default(1),
    revoked: boolean('revoked').notNull().default(false),
    encrypted: text('encrypted'),
    credentials: text('credentials'),
    createdAt: created(),
  },
  (t) => [uniqueIndex('binding_identity').on(t.connectionId, t.identity)],
);
export const catalogSnapshots = pgTable('catalog_snapshots', {
  id: text('id').primaryKey(),
  ownerId: owner(),
  connectionId: uuid('connection_id')
    .notNull()
    .references(() => connections.id, { onDelete: 'cascade' }),
  bindingId: text('binding_id')
    .notNull()
    .references(() => authorizationBindings.id, { onDelete: 'cascade' }),
  capabilityKey: text('capability_key').notNull(),
  encrypted: text('encrypted').notNull(),
  updatedAt: created(),
});
export const interactions = pgTable('interactions', {
  id: uuid('id').primaryKey(),
  ownerId: owner(),
  connectionId: uuid('connection_id')
    .notNull()
    .references(() => connections.id, { onDelete: 'cascade' }),
  bindingId: text('binding_id').notNull(),
  callId: uuid('call_id').notNull(),
  encrypted: text('encrypted').notNull(),
  status: text('status').notNull().default('waiting'),
  createdAt: created(),
});
