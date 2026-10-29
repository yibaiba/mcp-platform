import { Hono } from 'hono';
import { z } from 'zod';
import { zipSync, strToU8 } from 'fflate';
import { owner, paramId, type ApiEnv } from '../../shared/http.js';
import type { SshAccessService } from './service.js';
export function sshAccessRoutes(deps: {
  service: SshAccessService;
  readAsset: (name: string) => Promise<Uint8Array>;
}) {
  const app = new Hono<ApiEnv>();
  const service = deps.service;
  app.get('/', async (c) => c.json(await service.list(owner(c))));
  app.post('/', async (c) => c.json(await service.save(owner(c), await c.req.json()), 201));
  app.put('/:id', async (c) => {
    const { revision, ...config } = z
      .object({ revision: z.number().int().positive() })
      .loose()
      .parse(await c.req.json());
    return c.json(await service.save(owner(c), config, { id: paramId(c), revision }));
  });
  app.delete('/:id', async (c) => {
    const { revision } = z
      .object({ revision: z.number().int().positive() })
      .strict()
      .parse(await c.req.json());
    await service.remove(owner(c), paramId(c), revision);
    return c.json({ deleted: true });
  });
  app.get('/:id/windows-bundle', async (c) => {
    const config = await service.bundleConfig(owner(c), paramId(c));
    const assets = await Promise.all(
      ['Connect-McpPlatform.ps1', 'Install-Startup.ps1', 'Uninstall-Startup.ps1', 'README.txt'].map(
        async (name) => [name, await deps.readAsset(name)] as const,
      ),
    );
    const zip = zipSync({
      ...Object.fromEntries(assets),
      'connection.json': strToU8(JSON.stringify(config, null, 2)),
    });
    c.header('Cache-Control', 'no-store');
    c.header('Content-Type', 'application/zip');
    c.header('Content-Disposition', `attachment; filename="mcp-platform-ssh-${config.id}.zip"`);
    return c.body(new Uint8Array(zip).buffer);
  });
  return app;
}
