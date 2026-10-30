import { withExecution } from '../mcp/executionContext.js';
import { searchInput } from '../discovery/tools.js';
import { artifactToolset } from '../artifacts/artifactTools.js';
import { availablePermissionTools } from '../permissions/tools.js';
import type { Services } from '../../services.js';
import { z } from 'zod';
import { clientAuthModes, clientPresets, clientServerName, exportClient } from './clientExport.js';
import { Hono } from 'hono';
import { owner, paramId, type ApiEnv } from '../../shared/http.js';
import type { ProfileService } from './profileService.js';
import type { InvocationService } from '../mcp/invocationService.js';
import type { Gateway } from '../mcp/gateway.js';
import type { PiService } from '../pi-runtime/piService.js';
export function profileRoutes(deps: {
  profiles: ProfileService;
  artifacts: Services['artifacts'];
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
  app.get('/:id/search-index', async (c) =>
    c.json(await deps.profiles.discovery.status(owner(c), paramId(c))),
  );
  app.post('/:id/search-index/rebuild', async (c) => {
    const body = await c.req.text();
    const input = z
      .object({
        credentialId: z.string().min(1),
        capabilities: z.record(z.string(), z.unknown()).default({}),
        headers: z.record(z.string(), z.string()).optional(),
      })
      .strict()
      .optional()
      .parse(body.trim() ? JSON.parse(body) : undefined);
    const rebuild = async () => c.json(await deps.profiles.discovery.rebuild(owner(c), paramId(c)));
    return input
      ? withExecution(
          {
            ownerId: owner(c),
            profileId: paramId(c),
            credentialId: input.credentialId,
            identity: input.credentialId,
            capabilities: input.capabilities,
            headers: input.headers,
            entry: 'gateway',
            sessionId: 'index-management',
          },
          rebuild,
        )
      : rebuild();
  });
  app.post('/:id/search-test', async (c) =>
    c.json(
      await deps.profiles.discovery.searchDetailed(owner(c), {
        ...searchInput.parse(await c.req.json()),
        profileId: paramId(c),
      }),
    ),
  );
  app.get('/:id/context-footprint', async (c) =>
    c.json(
      await deps.profiles.discovery.footprint(owner(c), {
        profileId: paramId(c),
        extra: [
          ...(await availablePermissionTools(deps.requests, {
            ownerId: owner(c),
            profileId: paramId(c),
          })),
          ...(
            await artifactToolset(deps, {
              ownerId: owner(c),
              profileId: paramId(c),
            })
          ).tools,
        ],
      }),
    ),
  );
  app.get('/:id/export', async (c) => {
    const profile = await deps.profiles.owned(owner(c), paramId(c));
    const preset = z
      .enum(clientPresets)
      .default('generic-mcp-servers')
      .parse(c.req.query('client'));
    const auth = z.enum(clientAuthModes).default('key').parse(c.req.query('auth'));
    return c.json(
      exportClient({
        preset,
        auth,
        name: clientServerName(profile),
        url: `${deps.publicUrl}/mcp/${paramId(c)}`,
      }),
    );
  });
  const revokeKey = async (ownerId: string, id: string) => {
    await deps.profiles.revoke(ownerId, id);
    await deps.profiles.discovery.invalidateCredential(id);
    await deps.access.changed();
    for (const profile of await deps.profiles.list(ownerId))
      await deps.requests.reconcile(profile.id);
    await deps.gateway.revoke(id);
  };
  app.post('/:id/keys', async (c) => {
    // `replace: true` revokes this Agent's other keys so regenerating never piles up live keys.
    const input = z
      .object({ replace: z.boolean().default(false) })
      .strict()
      .parse((await c.req.text()) ? await c.req.json() : {});
    const profile = await deps.profiles.owned(owner(c), paramId(c));
    const key = await deps.profiles.issue(owner(c), paramId(c));
    const previous = input.replace
      ? (await deps.profiles.keys(owner(c)))
          .filter((row) => row.profileId === profile.id && !row.revoked && row.id !== key.id)
          .map((row) => row.id)
      : [];
    for (const id of previous) await revokeKey(owner(c), id);
    const name = clientServerName(profile);
    const url = `${deps.publicUrl}/mcp/${paramId(c)}`;
    return c.json(
      {
        ...key,
        revoked: previous,
        exports: clientPresets.map((preset) =>
          exportClient({ preset, url, name, token: key.token }),
        ),
        config: {
          mcpServers: {
            [name]: { type: 'http', url, headers: { Authorization: `Bearer ${key.token}` } },
          },
        },
      },
      201,
    );
  });
  app.get('/keys/all', async (c) => c.json(await deps.profiles.keys(owner(c))));
  app.delete('/keys/:id', async (c) => {
    await revokeKey(owner(c), paramId(c));
    return c.json({ revoked: true });
  });
  app.get('/:id', async (c) => c.json(await deps.profiles.owned(owner(c), paramId(c))));
  return app;
}
