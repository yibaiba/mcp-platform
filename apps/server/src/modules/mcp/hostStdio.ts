import { user, type Database } from '@platform/db';
import { eq } from 'drizzle-orm';
import { AppError } from '../../shared/errors.js';

/** Platform-host stdio: a local process spawned by the platform server itself (direct or Pi bridge). */
export function isHostStdio(config: { adapter?: string; transport?: string; source?: string }) {
  return config.transport === 'stdio' && config.adapter !== 'device';
}

export const hostStdioDisabledMessage =
  '在平台服务器上运行本地命令（stdio）已关闭（PLATFORM_STDIO_ENABLED=false）：请把运行位置改成“我的设备”，用设备连接器在你自己的电脑上运行';
export const hostStdioAdminMessage =
  '只有管理员可以在平台服务器上运行本地命令（stdio）：请把运行位置改成“我的设备”，用设备连接器在你自己的电脑上运行';

/** Rejects platform-host stdio unless the deployment switch is on and the owner is an admin. */
export async function assertHostStdioAllowed(
  db: Pick<Database, 'select'>,
  enabled: boolean,
  ownerId: string,
) {
  if (!enabled) throw new AppError('HOST_STDIO_DISABLED', hostStdioDisabledMessage, 403);
  const [row] = await db.select({ role: user.role }).from(user).where(eq(user.id, ownerId));
  if (row?.role !== 'admin')
    throw new AppError('HOST_STDIO_ADMIN_ONLY', hostStdioAdminMessage, 403);
}
