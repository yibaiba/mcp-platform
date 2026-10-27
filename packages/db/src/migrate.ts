import { config } from 'dotenv';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDatabase } from './index.js';
config({ path: new URL('../../../.env', import.meta.url).pathname });
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const { db, pool } = createDatabase(process.env.DATABASE_URL);
try {
  await migrate(db, { migrationsFolder: new URL('../migrations', import.meta.url).pathname });
} finally {
  await pool.end();
}
