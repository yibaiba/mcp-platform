import { pgTable, uuid, text, integer, timestamp, index } from 'drizzle-orm/pg-core';

export const systemLogs = pgTable(
  'system_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    at: timestamp('at', { withTimezone: true }).defaultNow().notNull(),
    level: text('level', { enum: ['info', 'warn', 'error'] }).notNull(),
    event: text('event').notNull(),
    ownerId: text('owner_id'),
    code: text('code'),
    method: text('method'),
    route: text('route'),
    status: integer('status'),
    durationMs: integer('duration_ms'),
  },
  (t) => [
    index('system_logs_time').on(t.at, t.id),
    index('system_logs_level_time').on(t.level, t.at, t.id),
  ],
);
