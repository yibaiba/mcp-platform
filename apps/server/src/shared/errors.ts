export class AppError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}
export function requireValue<T>(value: T | null | undefined, message = '资源不存在'): T {
  if (value == null) throw new AppError('NOT_FOUND', message, 404);
  return value;
}
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '未知错误';
}
