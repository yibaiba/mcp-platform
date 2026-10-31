import { pgTable, text, timestamp } from 'drizzle-orm/pg-core';
/**
 * One row per deployment secret (BETTER_AUTH_SECRET, ENCRYPTION_KEY, ...): a one-way fingerprint
 * of the value first seen with this database, never the value itself. Startup refuses a
 * different value so sessions and encrypted data are not silently lost.
 */
export const deploymentSecrets = pgTable('deployment_secrets', {
  name: text('name').primaryKey(),
  fingerprint: text('fingerprint').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
