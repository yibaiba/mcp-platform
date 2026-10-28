import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { randomBytes } from 'node:crypto';
import { fixtureMcp } from './fixtureMcp.js';
import type { Server } from 'node:http';
export async function oauthFixture(
  options: { expiresIn?: number; multipleIdentities?: boolean } = {},
) {
  const mcp = await fixtureMcp();
  const app = new Hono();
  let origin = '';
  let current = '';
  const validTokens = new Set<string>();
  let refreshes = 0;
  let dispatches = 0;
  const agents: string[] = [];
  app.use('*', async (c, next) => {
    if (c.req.path !== '/mcp') agents.push(c.req.header('User-Agent') ?? '');
    await next();
  });
  app.get('/.well-known/oauth-protected-resource/mcp', (c) =>
    c.json({ resource: `${origin}/mcp`, authorization_servers: [origin] }),
  );
  app.get('/.well-known/oauth-authorization-server', (c) =>
    c.json({
      issuer: origin,
      authorization_endpoint: `${origin}/authorize`,
      token_endpoint: `${origin}/token`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
    }),
  );
  app.post('/token', async (c) => {
    const input = new URLSearchParams(await c.req.text());
    if (input.get('grant_type') === 'refresh_token') refreshes++;
    current = randomBytes(16).toString('hex');
    validTokens.add(current);
    return c.json({
      access_token: current,
      refresh_token: randomBytes(16).toString('hex'),
      token_type: 'Bearer',
      expires_in: refreshes ? 3600 : (options.expiresIn ?? 3600),
    });
  });
  app.all('/mcp', async (c) => {
    if (
      c.req.method === 'POST' &&
      ((await c.req.raw.clone().json()) as { method?: string }).method === 'tools/call'
    )
      dispatches++;
    if (
      options.multipleIdentities
        ? !validTokens.has((c.req.header('Authorization') ?? '').replace(/^Bearer /, ''))
        : !current || c.req.header('Authorization') !== `Bearer ${current}`
    )
      return new Response(null, {
        status: 401,
        headers: {
          'WWW-Authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
        },
      });
    return fetch(new Request(mcp.url, c.req.raw));
  });
  const server = serve({ fetch: app.fetch, port: 0 });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No OAuth fixture address');
  origin = `http://127.0.0.1:${address.port}`;
  return {
    origin,
    expire: () => {
      current = '';
    },
    refreshes: () => refreshes,
    dispatches: () => dispatches,
    agents: () => agents,
    close: async () => {
      const closed = new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      // The test has closed its MCP clients; terminate remaining proxy/keep-alive sockets.
      (server as Server).closeAllConnections();
      await closed;
      await mcp.close();
    },
  };
}
