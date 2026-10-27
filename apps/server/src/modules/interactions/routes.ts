import { Hono } from 'hono';
import { z } from 'zod';
import { owner, paramId, type ApiEnv } from '../../shared/http.js';
import type { InteractionService } from './interactionService.js';
const responses = z.record(
  z.string(),
  z
    .object({
      action: z.enum(['accept', 'decline', 'cancel']),
      content: z
        .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]))
        .optional(),
    })
    .strict(),
);
export function interactionRoutes(service: InteractionService) {
  const app = new Hono<ApiEnv>();
  app.get('/', async (c) => c.json(await service.list(owner(c))));
  app.post('/:id/respond', async (c) =>
    c.json(
      await service.respond({
        ownerId: owner(c),
        id: paramId(c),
        responses: responses.parse(await c.req.json()),
      }),
    ),
  );
  return app;
}
