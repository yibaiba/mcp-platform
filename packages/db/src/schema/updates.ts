import { boolean, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { connections } from './platform.js';
import { user } from './auth.js';
export const networkConfiguration = pgTable('network_configuration', {
  id: text('id').primaryKey(),
  revision: integer('revision').notNull(),
  encrypted: text('encrypted').notNull(),
});
export const updateChecks = pgTable('update_checks', {
  id: text('id').primaryKey(),
  ownerId: text('owner_id').references(() => user.id, { onDelete: 'cascade' }),
  connectionId: uuid('connection_id').references(() => connections.id, { onDelete: 'cascade' }),
  fingerprint: text('fingerprint').notNull(),
  scheduled: boolean('scheduled').notNull().default(false),
  result: jsonb('result').$type<Record<string, unknown>>(),
  nextCheckAt: timestamp('next_check_at', { withTimezone: true }),
});
