import { pgTable, uuid, text, integer, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { user } from './auth.js';
import { connections } from './platform.js';
export const sshAccesses = pgTable('ssh_accesses', {
  id: uuid('id').primaryKey().defaultRandom(),
  ownerId: text('owner_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  platform: text('platform').notNull(),
  host: text('host').notNull(),
  port: integer('port').notNull(),
  username: text('username').notNull(),
  identityFile: text('identity_file').notNull(),
  reconnectIntervalSeconds: integer('reconnect_interval_seconds').notNull(),
  revision: integer('revision').notNull().default(1),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});
export const sshBindings = pgTable(
  'ssh_bindings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accessId: uuid('access_id')
      .notNull()
      .references(() => sshAccesses.id, { onDelete: 'cascade' }),
    connectionId: uuid('connection_id')
      .notNull()
      .references(() => connections.id, { onDelete: 'cascade' }),
    localPort: integer('local_port').notNull(),
    remotePort: integer('remote_port').notNull(),
    host: text('host').notNull(),
    port: integer('port').notNull(),
  },
  (t) => [
    uniqueIndex('ssh_connection_unique').on(t.connectionId),
    uniqueIndex('ssh_listener_unique').on(t.host, t.port, t.remotePort),
  ],
);
