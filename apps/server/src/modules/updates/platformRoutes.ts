import { Hono } from 'hono';
import { owner, type ApiEnv } from '../../shared/http.js';
import type { PlatformUpdateService } from './platformService.js';
export function platformUpdateRoutes(service: PlatformUpdateService) {
  const app = new Hono<ApiEnv>();
  app.get('/version', async (c) => {
    c.header('Cache-Control', 'no-store');
    return c.json(await service.status());
  });
  app.get('/admin/platform-update', async (c) => c.json(await service.adminStatus(owner(c))));
  app.post('/admin/platform-update', async (c) => c.json(await service.check(owner(c))));
  app.patch('/admin/platform-update', async (c) =>
    c.json(await service.schedule(owner(c), await c.req.json())),
  );
  return app;
}
