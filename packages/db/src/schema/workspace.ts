import { pgTable, text, uuid, jsonb, integer, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import type { PermissionSet } from '@platform/contracts';
import { user } from './auth.js';
import { profiles } from './platform.js';
const owner = () =>
  text('owner_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' });
const created = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
export const permissionRequests = pgTable(
  'permission_requests',
  {
    id: uuid('id').primaryKey(),
    ownerId: owner(),
    profileId: uuid('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    subject: text('subject').notNull(),
    taskId: uuid('task_id'),
    profileRevision: integer('profile_revision').notNull(),
    bindings: jsonb('bindings').$type<Record<string, string>>().notNull(),
    requested: jsonb('requested').$type<PermissionSet>().notNull(),
    approved: jsonb('approved').$type<PermissionSet>(),
    reason: text('reason').notNull(),
    status: text('status').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    deadline: timestamp('deadline', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    createdAt: created(),
  },
  (t) => [
    uniqueIndex('permission_request_idempotency').on(t.profileId, t.subject, t.idempotencyKey),
  ],
);
export const temporaryGrants = pgTable('temporary_grants', {
  id: uuid('id').primaryKey(),
  ownerId: owner(),
  profileId: uuid('profile_id')
    .notNull()
    .references(() => profiles.id, { onDelete: 'cascade' }),
  subject: text('subject').notNull(),
  taskId: uuid('task_id'),
  requestId: uuid('request_id').unique(),
  profileRevision: integer('profile_revision').notNull(),
  bindings: jsonb('bindings').$type<Record<string, string>>().notNull(),
  permissions: jsonb('permissions').$type<PermissionSet>().notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  createdAt: created(),
});
export const workspaceEvents = pgTable(
  'workspace_events',
  {
    id: uuid('id').primaryKey(),
    ownerId: owner(),
    aggregateId: uuid('aggregate_id').notNull(),
    kind: text('kind').notNull(),
    revision: integer('revision').notNull(),
    data: jsonb('data').$type<Record<string, unknown>>().notNull(),
    createdAt: created(),
  },
  (t) => [uniqueIndex('workspace_event_revision').on(t.aggregateId, t.revision)],
);
export const handoffs = pgTable(
  'handoffs',
  {
    id: uuid('id').primaryKey(),
    ownerId: owner(),
    sourceTaskId: uuid('source_task_id').notNull(),
    targetProfileId: uuid('target_profile_id')
      .notNull()
      .references(() => profiles.id),
    targetRevision: integer('target_revision').notNull(),
    summary: text('summary').notNull(),
    artifactIds: jsonb('artifact_ids').$type<string[]>().notNull(),
    mode: text('mode').$type<'pi' | 'external'>().notNull(),
    credentialId: uuid('credential_id'),
    idempotencyKey: text('idempotency_key').notNull(),
    status: text('status').notNull(),
    taskId: uuid('task_id').unique(),
    error: text('error'),
    createdAt: created(),
  },
  (t) => [uniqueIndex('handoff_idempotency').on(t.ownerId, t.idempotencyKey)],
);
