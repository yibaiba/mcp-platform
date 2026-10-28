import { user, type Database } from '@platform/db';
import { eq } from 'drizzle-orm';
import { AppError } from '../../shared/errors.js';

export async function activeUser(db: Pick<Database, 'select'>, id: string) {
  const [row] = await db.select().from(user).where(eq(user.id, id)).for('share');
  if (!row?.enabled) throw new AppError('UNAUTHORIZED', '账号已停用或不存在', 401);
  return row;
}

export async function adminUser(db: Database, id: string) {
  const row = await activeUser(db, id);
  if (row.role !== 'admin') throw new AppError('ADMIN_REQUIRED', '此操作需要管理员权限', 403);
  return row;
}
