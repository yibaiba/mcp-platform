import { Hono } from 'hono';
import { z } from 'zod';
import { owner, type ApiEnv } from '../../shared/http.js';
import type { UserService } from './userService.js';
const id = (value: string) => z.string().min(1).parse(value);

export function userRoutes(service: UserService) {
  const app = new Hono<ApiEnv>();
  app.get('/admin/users', async (c) => c.json(await service.list(owner(c))));
  app.post('/admin/users', async (c) =>
    c.json(await service.create(owner(c), await c.req.json()), 201),
  );
  app.patch('/admin/users/:id', async (c) =>
    c.json(await service.update(owner(c), id(c.req.param('id')), await c.req.json())),
  );
  app.get('/admin/users/:id/sessions', async (c) =>
    c.json(await service.sessions(owner(c), id(c.req.param('id')))),
  );
  app.delete('/admin/users/:id/sessions', async (c) => {
    await service.revokeSessions({ actorId: owner(c), targetId: id(c.req.param('id')) });
    return c.json({ revoked: true });
  });
  app.get('/me/sessions', async (c) => c.json(await service.sessions(owner(c))));
  app.delete('/me/sessions/:id', async (c) => {
    await service.revokeSessions({
      actorId: owner(c),
      targetId: owner(c),
      sessionId: id(c.req.param('id')),
    });
    return c.json({ revoked: true });
  });
  return app;
}
