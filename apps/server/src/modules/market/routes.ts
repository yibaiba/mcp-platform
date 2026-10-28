import { Hono } from 'hono';
import { z } from 'zod';
import { owner, type ApiEnv } from '../../shared/http.js';
import type { MarketService } from './marketService.js';
export function marketRoutes(service: MarketService) {
  const app = new Hono<ApiEnv>();
  app.get('/servers', async (c) =>
    c.json(
      await service.search(
        z
          .object({ search: z.string().optional(), cursor: z.string().optional() })
          .parse(c.req.query()),
      ),
    ),
  );
  app.get('/versions', async (c) =>
    c.json(await service.versions(z.string().min(1).parse(c.req.query('name')))),
  );
  app.get('/server', async (c) => {
    const input = z
      .object({ name: z.string().min(1), version: z.string().min(1).default('latest') })
      .parse(c.req.query());
    return c.json(await service.detail(input.name, input.version));
  });
  app.post('/preview', async (c) => c.json(await service.preview(owner(c), await c.req.json())));
  app.post('/install', async (c) => {
    const result = await service.install(owner(c), await c.req.json());
    return c.json(result, result.status === 'connected' ? 201 : 502);
  });
  return app;
}
