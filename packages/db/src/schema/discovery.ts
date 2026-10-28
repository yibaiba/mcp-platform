import {
  pgTable,
  text,
  uuid,
  doublePrecision,
  primaryKey,
  timestamp,
  index,
} from 'drizzle-orm/pg-core';
import { user } from './auth.js';
import { profiles } from './platform.js';
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
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.ownerId, t.profileId, t.scope, t.toolId] }),
    index('tool_vectors_scope').on(t.ownerId, t.profileId, t.scope),
  ],
);
