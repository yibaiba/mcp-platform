import { Hono } from 'hono';
import { owner, paramId, type ApiEnv } from '../../shared/http.js';
import type { ActivityService } from './activityService.js';
export function activityRoutes(service: ActivityService) {
  const app = new Hono<ApiEnv>();
  app.get('/', async (c) => c.json(await service.list(owner(c), c.req.query())));
  app.get('/stats', async (c) => c.json(await service.stats(owner(c), c.req.query())));
  app.get('/:id', async (c) => c.json(await service.detail(owner(c), paramId(c))));
  app.post('/cleanup/preview', async (c) =>
    c.json(await service.preview(owner(c), await c.req.json())),
  );
  app.post('/cleanup', async (c) => c.json(await service.clear(owner(c), await c.req.json())));
  return app;
}
