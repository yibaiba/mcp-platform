import {
  pgTable,
  text,
  uuid,
  jsonb,
  integer,
  boolean,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { user } from './auth.js';
import { devices } from './platform.js';
import type { LocalResource, LocalSource } from '@platform/contracts';
const owner = () =>
  text('owner_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' });
const device = () =>
  uuid('device_id')
    .notNull()
    .references(() => devices.id, { onDelete: 'cascade' });
export const localSources = pgTable('local_sources', {
  id: text('id').primaryKey(),
  ownerId: owner(),
  deviceId: device(),
  sourceId: text('source_id').notNull(),
  metadata: jsonb('metadata').$type<LocalSource>().notNull(),
});
export const localBindings = pgTable(
  'local_bindings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: owner(),
    deviceId: device(),
    resourceId: text('resource_id').notNull(),
    metadata: jsonb('metadata').$type<Omit<LocalResource, 'content'>>().notNull(),
    baseline: jsonb('baseline').$type<LocalResource['content']>().notNull(),
    content: jsonb('content').$type<LocalResource['content']>().notNull(),
    localDigest: text('local_digest').notNull(),
    revision: integer('revision').notNull().default(1),
    active: boolean('active').notNull().default(true),
    deleted: boolean('deleted').notNull().default(false),
    status: text('status').notNull().default('pending'),
    error: text('error'),
    connectionId: uuid('connection_id'),
    connectionRevision: integer('connection_revision'),
    skillVersionId: uuid('skill_version_id'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex('local_binding_resource').on(t.deviceId, t.resourceId)],
);
export const localOperations = pgTable('local_operations', {
  id: text('id').primaryKey(),
  ownerId: owner(),
  deviceId: device(),
  resourceId: text('resource_id'),
  requestDigest: text('request_digest').notNull(),
  action: text('action').notNull(),
  phase: text('phase').notNull(),
  input: jsonb('input').$type<Record<string, unknown>>().notNull(),
  result: jsonb('result').$type<unknown>(),
  error: text('error'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});
