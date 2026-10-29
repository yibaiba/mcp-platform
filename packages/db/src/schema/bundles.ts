import { pgTable, uuid, text, jsonb, uniqueIndex } from 'drizzle-orm/pg-core';
import { user } from './auth.js';
import { connections } from './platform.js';
export const mcpbPackages = pgTable(
  'mcpb_packages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    sha256: text('sha256').notNull(),
    manifest: jsonb('manifest').$type<Record<string, unknown>>().notNull(),
  },
  (t) => [uniqueIndex('mcpb_owner_digest').on(t.ownerId, t.sha256)],
);
export const mcpbInstalls = pgTable('mcpb_installs', {
  id: uuid('id').primaryKey(),
  ownerId: text('owner_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  packageId: uuid('package_id')
    .notNull()
    .references(() => mcpbPackages.id),
  fingerprint: text('fingerprint').notNull(),
  state: text('state').notNull(),
  connectionId: uuid('connection_id').references(() => connections.id, { onDelete: 'set null' }),
  error: text('error'),
});
