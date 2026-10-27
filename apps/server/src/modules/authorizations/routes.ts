import { Hono } from 'hono';
import { z } from 'zod';
import { owner, paramId, type ApiEnv } from '../../shared/http.js';
import type { ConnectionService } from '../mcp/connectionService.js';
import type { UpstreamOAuth } from './upstreamOAuth.js';
import type { PiService } from '../pi-runtime/piService.js';
import { withExecution } from '../mcp/executionContext.js';
import { AppError } from '../../shared/errors.js';
import type { ConnectionContext } from '../mcp/adapter.js';
export function authorizationRoutes(
  deps: {
    connections: ConnectionService;
    oauth: UpstreamOAuth;
    pi: PiService;
    changed?: () => Promise<void>;
  },
  binding = false,
) {
  const app = new Hono<ApiEnv>();
  const prefix = binding ? '/:id/bindings/:bindingId/oauth' : '/:id/oauth';
  if (binding)
    app.use('/:id/bindings/:bindingId/*', async (c, next) => {
      const id = paramId(c);
      await deps.connections.owned(owner(c), id);
      const row = (await deps.connections.bindings.list(owner(c), id)).find(
        (item) => item.id === c.req.param('bindingId'),
      );
      if (!row) throw new AppError('NOT_FOUND', '授权绑定不存在', 404);
      await withExecution(
        {
          identity: row.identity,
          ownerId: owner(c),
          bindingIdentity: row.identity,
          entry: 'dashboard',
          sessionId: 'authorization',
          capabilities: {},
        },
        next,
      );
    });
  async function httpContext(ownerId: string, connectionId: string) {
    const context = await deps.connections.context(ownerId, connectionId);
    if (context.config.transport === 'stdio')
      throw new AppError(
        'OAUTH_NOT_APPLICABLE',
        'stdio 不使用上游 HTTP OAuth；请通过进程环境变量配置凭证',
      );
    return context;
  }
  async function identityChanged(context: ConnectionContext) {
    await deps.connections.closeBinding(context);
    await deps.connections.bindings.invalidate(context);
    await deps.changed?.();
  }
  app.get(`${prefix}`, async (c) => {
    const context = await httpContext(owner(c), paramId(c));
    return Response.json(
      context.config.adapter === 'pi'
        ? await deps.pi.action(context, { action: 'status' })
        : await deps.oauth.status(context),
    );
  });
  app.post(`${prefix}/start`, async (c) => {
    const context = await httpContext(owner(c), paramId(c));
    await identityChanged(context);
    return Response.json(
      context.config.adapter === 'pi'
        ? await deps.pi.action(context, { action: 'auth-start' })
        : await deps.oauth.start(context),
    );
  });
  app.post(`${prefix}/complete`, async (c) => {
    const context = await httpContext(owner(c), paramId(c));
    const input = z
      .object({ redirectUrl: z.url() })
      .strict()
      .parse(await c.req.json());
    if (context.config.adapter === 'pi') {
      const result = await deps.pi.action(context, { action: 'auth-complete', args: input });
      await identityChanged(context);
      return Response.json(result);
    }
    const url = new URL(input.redirectUrl);
    if (url.origin + url.pathname !== deps.oauth.provider(context).redirectUrl)
      return c.json({ error: '回调地址不匹配' }, 400);
    await deps.oauth.complete(context, {
      code: url.searchParams.get('code') ?? '',
      state: url.searchParams.get('state') ?? '',
      issuer: url.searchParams.get('iss') ?? undefined,
    });
    await identityChanged(context);
    return c.json({ authorized: true });
  });
  app.get(`${prefix}/callback`, async (c) => {
    const context = await httpContext(owner(c), paramId(c));
    const input = z
      .object({ code: z.string().min(1), state: z.string().min(1), iss: z.string().optional() })
      .transform((v) => ({ code: v.code, state: v.state, issuer: v.iss }))
      .parse(c.req.query());
    await deps.oauth.complete(context, input);
    await identityChanged(context);
    return c.html(
      '<!doctype html><html lang="zh"><meta charset="utf-8"><title>授权完成</title><p>授权完成，请回到 MCP 平台刷新工具。</p></html>',
    );
  });
  app.delete(`${prefix}`, async (c) => {
    const context = await httpContext(owner(c), paramId(c));
    await deps.connections.closeBinding(context);
    const result =
      context.config.adapter === 'pi'
        ? await deps.pi.action(context, { action: 'logout' })
        : await deps.oauth.revoke(context);
    await deps.connections.bindings.invalidate(context);
    await deps.changed?.();
    return Response.json(result);
  });
  return app;
}
