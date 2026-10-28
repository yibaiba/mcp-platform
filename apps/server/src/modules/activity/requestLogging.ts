import type { MiddlewareHandler } from 'hono';
import { matchedRoutes } from 'hono/route';
import { z } from 'zod';
import { AppError } from '../../shared/errors.js';
import type { ApiEnv } from '../../shared/http.js';
import type { SystemLogger, LogInput } from './systemLogger.js';
const methods = new Set([
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'HEAD',
  'OPTIONS',
  'CONNECT',
  'TRACE',
]);
export function requestLogging(logger: SystemLogger): MiddlewareHandler<ApiEnv> {
  return async (c, next) => {
    const started = performance.now();
    await next();
    // The static-web fallback is registered last. Prefer the most specific
    // matched template, never the raw request URL or its query parameters.
    const route = matchedRoutes(c)
      .map((item) => item.path)
      .sort((a, b) => b.length - a.length)[0];
    const code =
      c.error instanceof AppError
        ? c.error.code
        : c.error instanceof z.ZodError
          ? 'VALIDATION'
          : c.error
            ? 'INTERNAL_ERROR'
            : undefined;
    await logger.write({
      level: c.res.status >= 500 ? 'error' : c.res.status >= 400 ? 'warn' : 'info',
      event: 'http_request',
      ownerId: c.get('ownerId'),
      code,
      method: (methods.has(c.req.method) ? c.req.method : 'OTHER') as LogInput['method'],
      route,
      status: c.res.status,
      durationMs: Math.round(performance.now() - started),
    });
  };
}
