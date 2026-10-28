import { pgTable, uuid, text, integer, jsonb, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { user } from './auth.js';
export type ManifestEntryState = {
  kind: 'connection' | 'profile' | 'share';
  name: string;
  objectId?: string;
  managed: boolean;
  revision?: number;
  fingerprint?: string;
  status: 'pending' | 'ready' | 'error';
  reason?: string;
};
export const configManifests = pgTable(
  'config_manifests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    revision: integer('revision').notNull().default(1),
    declaration: jsonb('declaration')
      .$type<import('@platform/contracts').ConfigManifest>()
      .notNull(),
    mappings: jsonb('mappings').$type<import('@platform/contracts').ManifestMappings>().notNull(),
    mode: text('mode').$type<'upsert' | 'prune'>().notNull().default('upsert'),
    entries: jsonb('entries').$type<ManifestEntryState[]>().notNull().default([]),
    status: text('status').$type<'pending' | 'ready' | 'error'>().notNull().default('pending'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('config_manifests_owner_name').on(t.ownerId, t.name)],
);
export const configSecrets = pgTable(
  'config_secrets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    encrypted: text('encrypted').notNull(),
    revision: integer('revision').notNull().default(1),
  },
  (t) => [uniqueIndex('config_secrets_owner_name').on(t.ownerId, t.name)],
);
