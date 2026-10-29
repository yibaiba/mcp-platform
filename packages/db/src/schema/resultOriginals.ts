import { pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { artifacts } from './platform.js';
export const resultOriginals = pgTable('result_originals', {
  artifactId: uuid('artifact_id')
    .primaryKey()
    .references(() => artifacts.id, { onDelete: 'cascade' }),
  profileId: uuid('profile_id').notNull(),
  subject: text('subject').notNull(),
  toolId: text('tool_id').notNull(),
  callId: uuid('call_id').notNull(),
});
