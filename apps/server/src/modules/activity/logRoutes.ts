import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { Database } from '@platform/db';
import { owner, type ApiEnv } from '../../shared/http.js';
import { adminUser } from '../users/userAccess.js';
import type { LogService } from './logService.js';
import type { SystemLogger } from './systemLogger.js';
import { AppError } from '../../shared/errors.js';

export function logRoutes(deps: { db: Database; logs: LogService; logger: SystemLogger }) {
  const app = new Hono<ApiEnv>();
  app.get('/', async (c) => c.json(await deps.logs.list(owner(c), c.req.query())));
  app.post('/cleanup/preview', async (c) =>
    c.json(await deps.logs.preview(owner(c), await c.req.json())),
  );
  app.post('/cleanup', async (c) => c.json(await deps.logs.clear(owner(c), await c.req.json())));
  app.get('/stream', async (c) => {
    await adminUser(deps.db, owner(c));
    return streamSSE(c, async (stream) => {
      let finish!: () => void;
      const stopped = new Promise<void>((resolve) => {
        finish = resolve;
      });
      stream.onAbort(finish);
      let fail!: (error: unknown) => void;
      const failed = new Promise<never>((_, reject) => {
        fail = reject;
      });
      let writes = Promise.resolve();
      const unsubscribe = deps.logger.subscribe((entry) => {
        writes = writes
          .then(async () => {
            await adminUser(deps.db, owner(c));
            await stream.writeSSE({ event: 'log', id: entry.id, data: JSON.stringify(entry) });
          })
          .catch(async (error: unknown) => {
            try {
              await stream.writeSSE({
                event: 'error',
                data: JSON.stringify({
                  code: error instanceof AppError ? error.code : 'LOG_STREAM_FAILED',
                }),
              });
            } finally {
              await stream.close();
              finish();
            }
          });
        void writes.catch(() => fail(new Error('System log stream write failed')));
      });
      try {
        await stream.writeSSE({ event: 'ready', data: '{}' });
        await Promise.race([stopped, failed]);
      } finally {
        unsubscribe();
      }
    });
  });
  return app;
}
