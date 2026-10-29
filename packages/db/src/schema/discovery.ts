import { sql } from 'drizzle-orm';
import {
  pgTable,
  integer,
  text,
  uuid,
  doublePrecision,
  primaryKey,
  timestamp,
  index,
} from 'drizzle-orm/pg-core';
import { user } from './auth.js';
import { profiles, catalogSnapshots } from './platform.js';
export const toolVectors = pgTable(
  'tool_vectors',
  {
    ownerId: text('owner_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    profileId: uuid('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    scope: text('scope').notNull(),
    toolId: text('tool_id').notNull(),
    definitionHash: text('definition_hash').notNull(),
    vector: doublePrecision('vector').array().notNull(),
    dimensions: integer('dimensions')
      .generatedAlwaysAs(sql`cardinality(vector)`)
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.ownerId, t.profileId, t.scope, t.toolId] }),
    index('tool_vectors_scope').on(t.ownerId, t.profileId, t.scope),
  ],
);

// Retain lifecycle records after profile/account deletion so physical indexes can be dropped.
export const searchIndexes = pgTable('search_indexes', {
  id: uuid('id').primaryKey().defaultRandom(),
  ownerId: text('owner_id').references(() => user.id, { onDelete: 'set null' }),
  profileId: uuid('profile_id').references(() => profiles.id, { onDelete: 'set null' }),
  scope: text('scope').notNull().unique(),
  family: text('family').notNull(),
  credentialId: text('credential_id'),
  state: text('state').$type<'building' | 'ready' | 'failed' | 'cleaning'>().notNull(),
  fingerprint: text('fingerprint').notNull(),
  dimensions: integer('dimensions').notNull(),
  error: text('error'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const searchCatalogEntries = pgTable(
  'search_catalog_entries',
  {
    snapshotId: text('snapshot_id')
      .notNull()
      .references(() => catalogSnapshots.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    definitionHash: text('definition_hash').notNull(),
    encrypted: text('encrypted').notNull(),
  },
  (t) => [primaryKey({ columns: [t.snapshotId, t.name] })],
);
