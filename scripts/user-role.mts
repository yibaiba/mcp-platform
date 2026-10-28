import { config } from 'dotenv';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { createDatabase, user } from '../packages/db/src/index.js';

config({ path: new URL('../.env', import.meta.url).pathname, quiet: true });
const [email, role] = z
  .tuple([z.email(), z.enum(['admin', 'member'])])
  .parse(process.argv.slice(2));
const { db, pool } = createDatabase(z.url().parse(process.env.DATABASE_URL));
try {
  const rows = await db
    .update(user)
    .set({ role })
    .where(eq(user.email, email.toLowerCase()))
    .returning({ id: user.id, role: user.role });
  if (!rows.length) throw new Error('账号不存在；请先注册或由管理员创建');
  console.log(JSON.stringify(rows[0]));
} finally {
  await pool.end();
}
