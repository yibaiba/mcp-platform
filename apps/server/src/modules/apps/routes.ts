import { Hono } from 'hono';
import { z } from 'zod';
import { owner, paramId, type ApiEnv } from '../../shared/http.js';
import type { AppSessionService } from './appSessionService.js';
export function appRoutes(service: AppSessionService) {
  const app = new Hono<ApiEnv>();
  app.get('/', (c) => c.json(service.list(owner(c), c.req.query('taskId'))));
  app.get('/:id', async (c) => c.json(await service.view(owner(c), paramId(c))));
  app.delete('/:id', (c) => {
    service.close(owner(c), paramId(c));
    return c.json({ closed: true });
  });
  app.post('/:id/call', async (c) =>
    c.json(
      await service.call(owner(c), paramId(c), {
        ...z
          .object({ name: z.string(), arguments: z.record(z.string(), z.unknown()).optional() })
          .strict()
          .parse(await c.req.json()),
        signal: c.req.raw.signal,
      }),
    ),
  );
  app.post('/:id/read', async (c) =>
    c.json(
      await service.resource(
        owner(c),
        paramId(c),
        z.object({ uri: z.string() }).parse(await c.req.json()).uri,
      ),
    ),
  );
  app.post('/:id/send', async (c) =>
    c.json(
      await service.send(
        owner(c),
        paramId(c),
        z
          .object({ text: z.string().min(1) })
          .strict()
          .parse(await c.req.json()).text,
      ),
    ),
  );
  app.post('/:id/context', async (c) =>
    c.json(await service.message(owner(c), paramId(c), { context: await c.req.json() })),
  );
  app.post('/:id/message', async (c) =>
    c.json(await service.message(owner(c), paramId(c), { message: await c.req.json() })),
  );
  return app;
}
