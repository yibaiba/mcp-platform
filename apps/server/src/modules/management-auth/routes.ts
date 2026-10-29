import { Hono } from 'hono';
import { cliAuthorize } from '@platform/contracts';
import { owner, paramId, type ApiEnv } from '../../shared/http.js';
import { AppError } from '../../shared/errors.js';
import type { CliAuthService } from './cliAuthService.js';
export function cliPublicRoutes(input: { auth: CliAuthService; webOrigin: string }) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    await next();
  });
  app.get('/authorize', (c) => {
    cliAuthorize.parse(c.req.query());
    const url = new URL('/cli-authorize', input.webOrigin);
    url.search = new URL(c.req.url).search;
    return c.redirect(url.toString());
  });
  app.post('/token', async (c) => c.json(await input.auth.token(await c.req.json())));
  return app;
}
export function cliManagementRoutes(auth: CliAuthService) {
  const app = new Hono<ApiEnv>();
  app.get('/grants', async (c) => c.json(await auth.list(owner(c))));
  app.delete('/grants/:id', async (c) => {
    await auth.revoke(owner(c), paramId(c));
    return c.json({ revoked: true });
  });
  app.post('/consent', async (c) => {
    if (c.get('cliGrantId'))
      throw new AppError('BROWSER_CONSENT_REQUIRED', 'CLI 授权必须在浏览器登录并确认', 403);
    c.header('Cache-Control', 'no-store');
    return c.json(await auth.consent(owner(c), await c.req.json()));
  });
  app.post('/logout', async (c) => {
    const id = c.get('cliGrantId');
    if (!id) throw new AppError('CLI_UNAUTHORIZED', '此入口需要 CLI 管理令牌', 401);
    await auth.revoke(owner(c), id);
    return c.json({ revoked: true });
  });
  return app;
}
