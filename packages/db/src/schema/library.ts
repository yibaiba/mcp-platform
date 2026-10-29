import { pgTable, text, uuid, uniqueIndex } from 'drizzle-orm/pg-core';
import { connections } from './platform.js';
import { user } from './auth.js';
// Content and templates remain encrypted in the owning connection configuration.
export const libraryEntries = pgTable(
  'library_entries',
  {
    connectionId: uuid('connection_id')
      .primaryKey()
      .references(() => connections.id, { onDelete: 'cascade' }),
    ownerId: text('owner_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull().$type<'prompt' | 'resource'>(),
    name: text('name').notNull(),
    locator: text('locator').notNull(),
  },
  (table) => [
    uniqueIndex('library_owner_kind_name').on(table.ownerId, table.kind, table.name),
    uniqueIndex('library_owner_kind_locator').on(table.ownerId, table.kind, table.locator),
  ],
);
