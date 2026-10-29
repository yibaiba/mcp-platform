import { Hono, type Context } from 'hono';
import type { Principal } from '../agent-profiles/profileService.js';
import { z } from 'zod';
import type { Services } from '../../services.js';
import { bearer, paramId, type ApiEnv } from '../../shared/http.js';
import { exportOpenApi } from './openapi.js';
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
export function restRoutes(deps: { services: Services; publicUrl: string }) {
  const app = new Hono<ApiEnv>();
  const { profiles, rest } = deps.services;
  const context = <T>(c: Context<ApiEnv>, principal: Principal, action: () => T) =>
    rest.context(principal, action, c.req.header());
  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    await next();
  });
  app.get('/:profileId/openapi.json', async (c) => {
    const principal = await profiles.authenticate(
      paramId(c, 'profileId'),
      bearer(c.req.raw.headers),
    );
    return context(c, principal, async () =>
      c.json(await exportOpenApi(profiles, { ...principal, publicUrl: deps.publicUrl })),
    );
  });
  app.get('/:profileId/rest/search-index', async (c) => {
    const principal = await profiles.authenticate(
      paramId(c, 'profileId'),
      bearer(c.req.raw.headers),
    );
    return context(c, principal, async () =>
      c.json(await profiles.discovery.status(principal.ownerId, principal.profileId)),
    );
  });
  app.post('/:profileId/rest/search-index/rebuild', async (c) => {
    const principal = await profiles.authenticate(
      paramId(c, 'profileId'),
      bearer(c.req.raw.headers),
    );
    return context(c, principal, async () =>
      c.json(await profiles.discovery.rebuild(principal.ownerId, principal.profileId)),
    );
  });
  app.get('/:profileId/rest/tools', async (c) => {
    const principal = await profiles.authenticate(
      paramId(c, 'profileId'),
      bearer(c.req.raw.headers),
    );
    return context(c, principal, async () =>
      c.json(await profiles.searchCatalog(principal.ownerId, principal.profileId)),
    );
  });
  app.get('/:profileId/rest/tools/:toolId', async (c) => {
    const principal = await profiles.authenticate(
      paramId(c, 'profileId'),
      bearer(c.req.raw.headers),
    );
    return context(c, principal, async () => {
      const row = await profiles.tool(principal.ownerId, {
        profileId: principal.profileId,
        toolId: c.req.param('toolId'),
      });
      if (!row) return c.json({ error: '工具不存在或未授权' }, 403);
      return c.json(row);
    });
  });
  app.post('/:profileId/rest/tools/:toolId', async (c) => {
    const principal = await profiles.authenticate(
      paramId(c, 'profileId'),
      bearer(c.req.raw.headers),
    );
    const args = z.record(z.string(), z.unknown()).parse(await c.req.json());
    return context(c, principal, async () => {
      const result = await rest.start(principal, {
        toolId: c.req.param('toolId'),
        arguments: args,
        idempotencyKey: z.string().min(1).optional().parse(c.req.header('Idempotency-Key')),
      });
      c.header('X-Call-Id', result.callId);
      return c.json(result.body, result.status);
    });
  });
  app.get('/:profileId/rest/calls/:id', async (c) => {
    const principal = await profiles.authenticate(
      paramId(c, 'profileId'),
      bearer(c.req.raw.headers),
    );
    return context(c, principal, async () => c.json(await rest.status(principal, paramId(c))));
  });
  app.get('/:profileId/rest/calls/:id/result', async (c) => {
    const principal = await profiles.authenticate(
      paramId(c, 'profileId'),
      bearer(c.req.raw.headers),
    );
    return context(c, principal, async () => c.json(await rest.result(principal, paramId(c))));
  });
  app.post('/:profileId/rest/calls/:id/answer', async (c) => {
    const principal = await profiles.authenticate(
      paramId(c, 'profileId'),
      bearer(c.req.raw.headers),
    );
    const input = z
      .object({ interactionId: z.uuid(), responses })
      .strict()
      .parse(await c.req.json());
    return context(c, principal, async () => {
      const result = await rest.answer(principal, { id: paramId(c), ...input });
      c.header('X-Call-Id', result.callId);
      return c.json(result.body, result.status);
    });
  });
  app.post('/:profileId/rest/calls/:id/cancel', async (c) => {
    const principal = await profiles.authenticate(
      paramId(c, 'profileId'),
      bearer(c.req.raw.headers),
    );
    return context(c, principal, async () => c.json(await rest.cancel(principal, paramId(c))));
  });
  return app;
}
