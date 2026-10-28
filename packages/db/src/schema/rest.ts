import { pgTable, text, uuid, timestamp, uniqueIndex, index } from 'drizzle-orm/pg-core';
import { user } from './auth.js';
import { profiles } from './platform.js';
export const restCalls = pgTable(
  'rest_calls',
  {
    id: uuid('id').primaryKey(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    profileId: uuid('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    credentialId: uuid('credential_id').notNull(),
    toolId: text('tool_id').notNull(),
    requestHash: text('request_hash').notNull(),
    idempotencyHash: text('idempotency_hash'),
    status: text('status')
      .$type<
        'running' | 'waiting' | 'succeeded' | 'tool_error' | 'failed' | 'unknown' | 'result_error'
      >()
      .notNull()
      .default('running'),
    interactionId: uuid('interaction_id'),
    resultDigest: text('result_digest'),
    errorCode: text('error_code'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('rest_calls_idempotency').on(
      t.ownerId,
      t.profileId,
      t.credentialId,
      t.idempotencyHash,
    ),
    index('rest_calls_owner_status').on(t.ownerId, t.status),
  ],
);
