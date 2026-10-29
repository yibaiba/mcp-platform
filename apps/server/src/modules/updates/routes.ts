import { Hono } from 'hono';
import { owner, paramId, type ApiEnv } from '../../shared/http.js';
import type { PackageUpdateService } from './packageService.js';
export function packageUpdateRoutes(service: PackageUpdateService) {
  const app = new Hono<ApiEnv>();
  app.get('/:id/package-update', async (c) => c.json(await service.status(owner(c), paramId(c))));
  app.post('/:id/package-update', async (c) => c.json(await service.check(owner(c), paramId(c))));
  app.patch('/:id/package-update', async (c) =>
    c.json(await service.schedule(owner(c), paramId(c), await c.req.json())),
  );
  return app;
}
