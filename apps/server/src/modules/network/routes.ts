import { Hono } from 'hono';
import { owner, type ApiEnv } from '../../shared/http.js';
import { adminUser } from '../users/userAccess.js';
import type { Database } from '@platform/db';
import type { NetworkService } from './service.js';
import { checkNetwork } from './checks.js';
export function networkRoutes(deps: { network: NetworkService; db: Database }) {
  const app = new Hono<ApiEnv>();
  app.use('*', async (c, next) => {
    await adminUser(deps.db, owner(c));
    c.header('Cache-Control', 'no-store');
    await next();
  });
  app.get('/', async (c) => c.json(await deps.network.view(owner(c))));
  app.put('/', async (c) => c.json(await deps.network.save(owner(c), await c.req.json())));
  app.post('/check', async (c) => c.json(await checkNetwork(deps.network)));
  return app;
}
