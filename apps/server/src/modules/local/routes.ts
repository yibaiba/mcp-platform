import { Hono } from 'hono';
import { z } from 'zod';
import { owner, paramId, type ApiEnv } from '../../shared/http.js';
import type { LocalService } from './localService.js';
export function localRoutes(service: LocalService) {
  const app = new Hono<ApiEnv>();
  app.get('/:id/local', async (c) => c.json(await service.state(owner(c), paramId(c))));
  app.post('/:id/local/request', async (c) =>
    c.json(await service.request(owner(c), paramId(c), await c.req.json())),
  );
  app.post('/:id/local/sync', async (c) => {
    const input = z
      .object({ operationId: z.string().min(1) })
      .strict()
      .parse(await c.req.json());
    return c.json(await service.startSync(owner(c), paramId(c), input.operationId), 202);
  });
  app.post('/:id/local/bindings/:bindingId', async (c) => {
    const input = z
      .object({
        revision: z.number().int().positive(),
        operationId: z.string().min(1),
        action: z.enum(['update', 'resolve', 'delete', 'unlink']),
        content: z.unknown().optional(),
        choice: z.enum(['local', 'platform', 'merge']).optional(),
        confirm: z.boolean().optional(),
      })
      .strict()
      .parse(await c.req.json());
    const result = await service.mutateBinding(owner(c), {
      ...input,
      deviceId: paramId(c),
      id: paramId(c, 'bindingId'),
    });
    // Reconciliation has its own durable operation and never waits in a tool call.
    if (service.online(paramId(c)) && (input.action === 'update' || input.action === 'resolve'))
      await service.startSync(owner(c), paramId(c), `${input.operationId}:sync`);
    return c.json(result);
  });
  return app;
}
