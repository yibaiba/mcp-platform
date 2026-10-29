import { pgTable, text, uuid, timestamp, jsonb, boolean, index } from 'drizzle-orm/pg-core';
import type { ManagementScope } from '@platform/contracts';
import { user } from './auth.js';
export const cliCodes = pgTable('cli_codes', {
  hash: text('hash').primaryKey(),
  ownerId: text('owner_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  redirectUri: text('redirect_uri').notNull(),
  challenge: text('challenge').notNull(),
  scopes: jsonb('scopes').$type<ManagementScope[]>().notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
});
export const cliGrants = pgTable(
  'cli_grants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    scopes: jsonb('scopes').$type<ManagementScope[]>().notNull(),
    accessHash: text('access_hash').notNull().unique(),
    refreshHash: text('refresh_hash').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    refreshExpiresAt: timestamp('refresh_expires_at', { withTimezone: true }).notNull(),
    revoked: boolean('revoked').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('cli_grants_owner').on(t.ownerId)],
);
