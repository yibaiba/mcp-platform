import { AppError } from '../../shared/errors.js';
export function bundleFailure(error: unknown, values: Record<string, unknown>) {
  const code = failureCode(error);
  let message =
    error instanceof AppError
      ? error.message
      : ((
          {
            ENOENT: '文件或可执行程序不存在',
            EACCES: '没有文件或执行权限',
            EPERM: '操作系统拒绝访问或进程清理',
            ENOSPC: '磁盘空间不足',
            ETIMEDOUT: '操作超时',
          } as Record<string, string>
        )[code] ?? '操作未完成，请结合连接诊断检查目标环境');
  for (const value of Object.values(values).flatMap((v) => (Array.isArray(v) ? v : [v]))) {
    if (typeof value === 'string' && value) message = message.replaceAll(value, '[redacted]');
  }
  return `[${code}] ${message.replace(/https?:\/\/\S+/g, '[地址]')}`;
}
function failureCode(error: unknown): string {
  if (!error || typeof error !== 'object') return 'MCPB_INSTALL_FAILED';
  const { code, cause } = error as { code?: unknown; cause?: unknown };
  if (typeof code === 'string' && /^[A-Z][A-Z0-9_]+$/.test(code)) return code;
  return cause && cause !== error ? failureCode(cause) : 'MCPB_INSTALL_FAILED';
}
