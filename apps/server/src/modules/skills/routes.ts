import { Hono } from 'hono';
import { z } from 'zod';
import { zipSync } from 'fflate';
import { owner, paramId, type ApiEnv } from '../../shared/http.js';
import { unpackZip } from './packageService.js';
import type { SkillService } from './skillService.js';
export function skillRoutes(
  service: SkillService,
  gitImport: (input: unknown) => Promise<{ package: unknown; source: string; revision: string }>,
) {
  const app = new Hono<ApiEnv>();
  app.get('/', async (c) => c.json(await service.list(owner(c))));
  app.post('/', async (c) =>
    c.json(await service.import(owner(c), { package: await c.req.json(), source: 'upload' }), 201),
  );
  app.post('/zip', async (c) =>
    c.json(
      await service.import(owner(c), {
        package: unpackZip(new Uint8Array(await c.req.arrayBuffer()), []),
        source: 'zip',
      }),
      201,
    ),
  );
  app.post('/git', async (c) =>
    c.json(await service.import(owner(c), await gitImport(await c.req.json())), 201),
  );
  app.get('/:id', async (c) => c.json(await service.version(owner(c), paramId(c))));
  app.get('/:id/export', async (c) => {
    const version = await service.version(owner(c), paramId(c));
    return new Response(
      Uint8Array.from(
        zipSync(
          Object.fromEntries(
            Object.entries(version.files).map(([path, base64]) => [
              path,
              Buffer.from(base64, 'base64'),
            ]),
          ),
        ),
      ),
      {
        headers: {
          'Content-Type': 'application/zip',
          'Content-Disposition': `attachment; filename="${version.name}.zip"`,
        },
      },
    );
  });
  app.post('/:id/install', async (c) => {
    const input = z
      .object({ profileId: z.uuid(), deviceId: z.uuid(), target: z.string().min(1) })
      .strict()
      .parse(await c.req.json());
    return c.json(
      await service.install(owner(c), {
        ...input,
        versionId: paramId(c),
        signal: c.req.raw.signal,
      }),
    );
  });
  return app;
}
