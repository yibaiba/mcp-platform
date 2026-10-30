import { user, type Database } from '@platform/db';
import { eq } from 'drizzle-orm';
import { AppError } from '../../shared/errors.js';

/** Platform-host stdio: a local process spawned by the platform server itself (direct or Pi bridge). */
export function isHostStdio(config: { adapter?: string; transport?: string; source?: string }) {
  return config.transport === 'stdio' && config.adapter !== 'device';
}

export const hostStdioDisabledMessage =
  '平台主机 stdio 已关闭（PLATFORM_STDIO_ENABLED=false）：请改用设备连接器在你自己的电脑上运行本地进程';
export const hostStdioAdminMessage =
  '只有管理员可以让平台主机运行 stdio 进程：请改用设备连接器在你自己的电脑上运行本地进程';

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
