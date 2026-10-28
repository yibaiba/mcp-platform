import { Hono } from 'hono';
import { owner, paramId, type ApiEnv } from '../../shared/http.js';
import { AppError } from '../../shared/errors.js';
import type { ShareService } from './shareService.js';

export function shareRoutes(shares: ShareService) {
  const app = new Hono<ApiEnv>();
  app.get('/shares', async (c) => c.json(await shares.incoming(owner(c))));
  app.put('/shares/:id/configuration', async (c) =>
    c.json(await shares.configure(owner(c), paramId(c), await c.req.json())),
  );
  app.get('/connections/:id/shares', async (c) =>
    c.json(await shares.outgoing(owner(c), paramId(c))),
  );
  app.get('/connections/:id/shares/catalog', async (c) =>
    c.json(await shares.catalog(owner(c), paramId(c))),
  );
  app.put('/connections/:id/shares', async (c) =>
    c.json(await shares.save(owner(c), paramId(c), await c.req.json())),
  );
  app.delete('/connections/:id/shares/:shareId', async (c) => {
    const grants = await shares.outgoing(owner(c), paramId(c));
    const id = paramId(c, 'shareId');
    if (!grants.some((grant) => grant.id === id))
      throw new AppError('NOT_FOUND', '共享授权不存在', 404);
    await shares.revoke(owner(c), id);
    return c.json({ revoked: true });
  });
  return app;
}
