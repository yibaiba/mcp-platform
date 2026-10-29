import { Hono } from 'hono';
import { z } from 'zod';
import { owner, paramId, type ApiEnv } from '../../shared/http.js';
import type { LibraryService } from './service.js';
export function libraryRoutes(service: LibraryService) {
  const app = new Hono<ApiEnv>();
  app.post('/prompts/preview', async (c) => c.json(service.preview(await c.req.json())));
  for (const [path, kind] of [
    ['prompts', 'prompt'],
    ['resources', 'resource'],
  ] as const) {
    app.get(`/${path}`, async (c) => c.json(await service.list(owner(c), kind)));
    app.get(`/${path}/:id`, async (c) =>
      c.json(await service.get(owner(c), { id: paramId(c), kind })),
    );
    app.post(`/${path}`, async (c) =>
      c.json(await service.save(owner(c), { kind, value: await c.req.json() }), 201),
    );
    app.put(`/${path}/:id`, async (c) =>
      c.json(await service.save(owner(c), { kind, id: paramId(c), value: await c.req.json() })),
    );
    app.delete(`/${path}/:id`, async (c) => {
      const { revision } = z
        .object({ revision: z.number().int().positive() })
        .strict()
        .parse(await c.req.json());
      await service.remove(owner(c), { id: paramId(c), kind, revision });
      return c.json({ deleted: true });
    });
  }
  return app;
}
