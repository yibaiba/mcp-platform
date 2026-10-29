import { Hono } from 'hono';
import { owner, paramId, type ApiEnv } from '../../shared/http.js';
import { AppError } from '../../shared/errors.js';
import type { BundleService } from './service.js';
export function bundleRoutes(service: BundleService) {
  const app = new Hono<ApiEnv>();
  app.get('/', async (c) => c.json(await service.lifecycle.history(owner(c))));
  app.delete('/:id', async (c) => c.json(await service.lifecycle.remove(owner(c), paramId(c))));
  app.post('/operations/:id/uninstall', async (c) =>
    c.json(await service.lifecycle.uninstall(owner(c), paramId(c))),
  );
  app.post('/', async (c) => {
    if (!c.req.raw.body) throw new AppError('MCPB_UPLOAD', '请选择 MCPB 文件');
    return c.json(await service.upload(owner(c), c.req.raw.body), 201);
  });
  app.get('/operations/:id', async (c) => c.json(await service.status(owner(c), paramId(c))));
  app.post('/:id/preview', async (c) =>
    c.json(await service.preview(owner(c), paramId(c), await c.req.json())),
  );
  app.post('/:id/install', async (c) =>
    c.json(await service.install(owner(c), paramId(c), await c.req.json())),
  );
  return app;
}
