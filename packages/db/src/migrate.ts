import { config } from 'dotenv';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDatabase, databaseUrl } from './index.js';
config({ path: new URL('../../../.env', import.meta.url).pathname });
const { db, pool } = createDatabase(databaseUrl());
try {
  await migrate(db, { migrationsFolder: new URL('../migrations', import.meta.url).pathname });
} finally {
  await pool.end();
}
