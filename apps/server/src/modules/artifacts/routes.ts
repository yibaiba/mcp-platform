import { Hono } from 'hono';
import { z } from 'zod';
import { owner, paramId, type ApiEnv } from '../../shared/http.js';
import type { ArtifactService } from './artifactService.js';
export function artifactRoutes(service: ArtifactService) {
  const app = new Hono<ApiEnv>();
  app.get('/', async (c) => c.json(await service.list(owner(c))));
  app.post('/', async (c) =>
    c.json(
      await service.upload(owner(c), {
        name: c.req.header('x-file-name') ? decodeURIComponent(c.req.header('x-file-name')!) : '',
        sha256: c.req.header('x-content-sha256') ?? '',
        body: c.req.raw.body,
      }),
      201,
    ),
  );
  app.get('/:id/content', async (c) => service.download(owner(c), paramId(c)));
  app.post('/transfers', async (c) => {
    const input = z
      .object({
        deviceId: z.uuid(),
        artifactId: z.uuid().optional(),
        direction: z.enum(['send', 'receive']),
        root: z.string().min(1),
        path: z.string().min(1),
      })
      .strict()
      .refine((v) => v.direction !== 'receive' || Boolean(v.artifactId))
      .parse(await c.req.json());
    return c.json(await service.transfer(owner(c), { ...input, signal: c.req.raw.signal }));
  });
  return app;
}
