import type { Services } from '../../services.js';
import { z } from 'zod';
import { clientPresets, exportClient } from './clientExport.js';
import { Hono } from 'hono';
import { owner, paramId, type ApiEnv } from '../../shared/http.js';
import type { ProfileService } from './profileService.js';
import type { InvocationService } from '../mcp/invocationService.js';
import type { Gateway } from '../mcp/gateway.js';
import type { PiService } from '../pi-runtime/piService.js';
export function profileRoutes(deps: {
  profiles: ProfileService;
  connections: Services['connections'];
  access: Services['access'];
  requests: Services['requests'];
  invocations: InvocationService;
  gateway: Gateway;
  pi: PiService;
  publicUrl: string;
}) {
  const app = new Hono<ApiEnv>();
  app.get('/', async (c) => c.json(await deps.profiles.list(owner(c))));
  app.post('/', async (c) => c.json(await deps.profiles.save(owner(c), await c.req.json()), 201));
  app.put('/:id', async (c) => {
    const profile = await deps.profiles.save(owner(c), await c.req.json(), paramId(c));
    await deps.access.changed();
    await deps.requests.reconcile(paramId(c));
    await deps.connections.closeProfile(paramId(c));
    await deps.gateway.permissionsChanged(paramId(c));
    await deps.gateway.profileChanged(paramId(c));
    await deps.pi.revokeProfile(paramId(c));
    return c.json(profile);
  });
  app.get('/:id/export', async (c) => {
    await deps.profiles.owned(owner(c), paramId(c));
    const preset = z
      .enum(clientPresets)
      .default('generic-mcp-servers')
      .parse(c.req.query('client'));
    return c.json(exportClient({ preset, url: `${deps.publicUrl}/mcp/${paramId(c)}` }));
  });
  app.post('/:id/keys', async (c) => {
    const key = await deps.profiles.issue(owner(c), paramId(c));
    return c.json(
      {
        ...key,
        exports: clientPresets.map((preset) =>
          exportClient({ preset, url: `${deps.publicUrl}/mcp/${paramId(c)}`, token: key.token }),
        ),
        config: {
          mcpServers: {
            platform: {
              type: 'http',
              url: `${deps.publicUrl}/mcp/${paramId(c)}`,
              headers: { Authorization: `Bearer ${key.token}` },
            },
          },
        },
      },
      201,
    );
  });
  app.get('/keys/all', async (c) => c.json(await deps.profiles.keys(owner(c))));
  app.delete('/keys/:id', async (c) => {
    await deps.profiles.revoke(owner(c), paramId(c));
    await deps.access.changed();
    for (const profile of await deps.profiles.list(owner(c)))
      await deps.requests.reconcile(profile.id);
    await deps.gateway.revoke(paramId(c));
    return c.json({ revoked: true });
  });
  return app;
}
