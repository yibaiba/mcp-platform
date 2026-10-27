import { Hono } from 'hono';
import { z } from 'zod';
import { owner, type ApiEnv } from '../../shared/http.js';
import type { ContentService } from './contentService.js';

export function contentRoutes(service: ContentService) {
  const app = new Hono<ApiEnv>();
  app.get('/', async (c) => c.json(await service.catalog({ ownerId: owner(c) })));
  app.post('/prompts/:id/get', async (c) => {
    const input = z
      .object({ arguments: z.record(z.string(), z.string()).default({}) })
      .strict()
      .parse(await c.req.json());
    return c.json(
      await service.prompt({
        ownerId: owner(c),
        id: c.req.param('id'),
        ...input,
        signal: c.req.raw.signal,
      }),
    );
  });
  app.post('/resources/read', async (c) => {
    const input = z
      .object({ uri: z.string().min(1) })
      .strict()
      .parse(await c.req.json());
    return c.json(await service.read({ ownerId: owner(c), ...input, signal: c.req.raw.signal }));
  });
  return app;
}
