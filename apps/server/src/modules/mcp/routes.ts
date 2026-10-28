import { Hono } from 'hono';
import { callInput } from '@platform/contracts';
import { owner, paramId, type ApiEnv } from '../../shared/http.js';
import type { ConnectionService } from './connectionService.js';
import type { ProfileService } from '../agent-profiles/profileService.js';
import type { InvocationService } from './invocationService.js';
export function connectionRoutes(service: ConnectionService, changed: () => Promise<void>) {
  const app = new Hono<ApiEnv>();
  app.get('/', async (c) => c.json(await service.list(owner(c))));
  app.post('/', async (c) => c.json(await service.create(owner(c), await c.req.json()), 201));
  app.post('/:id/discover', async (c) =>
    c.json(await service.discover(owner(c), paramId(c), c.req.raw.signal)),
  );
  app.patch('/:id', async (c) => {
    const result = await service.update(owner(c), paramId(c), await c.req.json());
    await changed();
    return c.json(result);
  });
  app.post('/:id/wake', async (c) => c.json(await service.wake(owner(c), paramId(c))));
  app.post('/:id/sleep', async (c) => {
    await service.sleep(owner(c), paramId(c));
    return c.json({ sleeping: true });
  });
  app.post('/:id/check', async (c) => c.json(await service.check(owner(c), paramId(c))));
  app.get('/:id/bindings', async (c) => {
    await service.accessible(owner(c), paramId(c));
    return c.json(await service.bindings.list(owner(c), paramId(c)));
  });
  app.post('/:id/stop', async (c) => {
    await service.stop(owner(c), paramId(c));
    return c.json({ stopped: true });
  });
  app.delete('/:id', async (c) => {
    await service.remove(owner(c), paramId(c));
    await changed();
    return c.json({ deleted: true });
  });
  return app;
}
export function toolRoutes(profiles: ProfileService, invocations: InvocationService) {
  const app = new Hono<ApiEnv>();
  app.get('/', async (c) => c.json(await profiles.catalog(owner(c))));
  app.post('/:toolId/call', async (c) => {
    const input = callInput.parse(await c.req.json());
    return c.json(
      await invocations.dispatch({
        ownerId: owner(c),
        toolId: c.req.param('toolId'),
        arguments: input.arguments,
        interactionDeadline: input.interactionDeadline,
        signal: c.req.raw.signal,
      }),
    );
  });
  return app;
}
