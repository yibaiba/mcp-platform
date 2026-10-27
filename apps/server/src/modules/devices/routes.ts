import { Hono } from 'hono';
import { z } from 'zod';
import { owner, paramId, type ApiEnv } from '../../shared/http.js';
import type { DeviceService } from './deviceService.js';
export function deviceRoutes(service: DeviceService) {
  const app = new Hono<ApiEnv>();
  app.get('/', async (c) => c.json(await service.list(owner(c))));
  app.post('/pairings', async (c) => {
    const input = z.object({ name: z.string().trim().min(1) }).parse(await c.req.json());
    return c.json(await service.createPairing(owner(c), input.name), 201);
  });
  app.delete('/:id', async (c) => {
    await service.revoke(owner(c), paramId(c));
    return c.json({ revoked: true });
  });
  return app;
}
