import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  jsonb,
  timestamp,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';
import { user } from './auth.js';
import { connections } from './platform.js';

/**
 * One "share with every account" grant per connection. Each enabled account other than the
 * owner gets a materialized `connection_shares` row pointing here (created on save and lazily
 * when an account first reads its grants, so later accounts are included). A direct
 * per-recipient grant on the same connection takes precedence over the team grant.
 */
export const connectionTeamShares = pgTable('connection_team_shares', {
  id: uuid('id').primaryKey().defaultRandom(),
  connectionId: uuid('connection_id')
    .notNull()
    .unique()
    .references(() => connections.id, { onDelete: 'cascade' }),
  ownerId: text('owner_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  credentialMode: text('credential_mode', { enum: ['independent', 'owner'] })
    .notNull()
    .default('independent'),
  toolIds: jsonb('tool_ids').$type<string[]>().notNull().default([]),
  contentIds: jsonb('content_ids').$type<string[]>().notNull().default([]),
  version: integer('version').notNull().default(1),
  revoked: boolean('revoked').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const connectionShares = pgTable(
  'connection_shares',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    connectionId: uuid('connection_id')
      .notNull()
      .references(() => connections.id, { onDelete: 'cascade' }),
    ownerId: text('owner_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    recipientId: text('recipient_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    credentialMode: text('credential_mode', { enum: ['independent', 'owner'] })
      .notNull()
      .default('independent'),
    toolIds: jsonb('tool_ids').$type<string[]>().notNull().default([]),
    contentIds: jsonb('content_ids').$type<string[]>().notNull().default([]),
    // Set when this row is the recipient's copy of a team grant; null for a direct grant.
    teamShareId: uuid('team_share_id').references(() => connectionTeamShares.id, {
      onDelete: 'cascade',
    }),
    receiverConfig: text('receiver_config'),
    status: text('status').notNull().default('disconnected'),
    error: text('error'),
    version: integer('version').notNull().default(1),
    revoked: boolean('revoked').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('connection_share_recipient').on(t.connectionId, t.recipientId),
    index('connection_shares_recipient').on(t.recipientId, t.revoked),
  ],
);
