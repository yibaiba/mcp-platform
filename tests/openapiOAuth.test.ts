import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { harness } from './harness.js';
let h: Awaited<ReturnType<typeof harness>>;
let http: ReturnType<typeof serve>;
let origin: string;
let tokens = 0;
let dispatched = 0;
let releaseExchange: (() => void) | undefined;
let exchangeStarted = false;
let cancelled = 0;
beforeAll(async () => {
  h = await harness();
  const app = new Hono();
  app.get('/.well-known/openid-configuration', (c) =>
    c.json({
      issuer: origin,
      authorization_endpoint: `${origin}/authorize`,
      token_endpoint: `${origin}/token`,
    }),
  );
  app.post('/token', async (c) => {
    tokens++;
    const params = new URLSearchParams(await c.req.text());
    expect(c.req.header('Authorization')).toBe(
      `Basic ${Buffer.from('client:secret').toString('base64')}`,
    );
    expect(params.has('client_secret')).toBe(false);
    if (params.get('code') === 'delayed') {
      exchangeStarted = true;
      await new Promise<void>((resolve) => {
        releaseExchange = resolve;
      });
    }
    return c.json({
      access_token: `token-${tokens}`,
      token_type: 'Bearer',
      refresh_token:
        params.get('grant_type') === 'client_credentials' ? undefined : 'rotating-refresh',
      expires_in: params.get('grant_type') === 'refresh_token' ? 3600 : 1,
      scope: 'read',
    });
  });
  app.get('/api', (c) => {
    dispatched++;
    expect(c.req.header('Authorization')).toMatch(/^Bearer token-/);
    return c.json({ real: true });
  });
  app.get('/wait', async (c) => {
    dispatched++;
    await new Promise<void>((resolve) =>
      c.req.raw.signal.addEventListener(
        'abort',
        () => {
          cancelled++;
          resolve();
        },
        { once: true },
      ),
    );
    return new Response('cancelled', { status: 499 });
  });
  http = serve({ port: 0, fetch: app.fetch });
  await new Promise<void>((resolve) => http.once('listening', resolve));
  const address = http.address();
  if (!address || typeof address === 'string') throw new Error('Missing API address');
  origin = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
  releaseExchange?.();
  await h?.close();
  await new Promise<void>((resolve) => http.close(() => resolve()));
});
async function setup(mode: 'clientCredentials' | 'oidc' | 'public') {
  const account = await h.signup();
  const scheme =
    mode === 'oidc'
      ? { type: 'openIdConnect', openIdConnectUrl: `${origin}/.well-known/openid-configuration` }
      : {
          type: 'oauth2',
          flows: { clientCredentials: { tokenUrl: `${origin}/token`, scopes: { read: 'Read' } } },
        };
  const path = mode === 'public' ? '/wait' : '/api';
  const connection = await h.services.connections.create(account.ownerId, {
    name: mode,
    source: 'openapi',
    adapter: 'direct',
    transport: 'http',
    mode: 'existing',
    openapi: {
      baseUrl: origin,
      operations: [`GET ${path}`],
      credentials:
        mode === 'public'
          ? {}
          : {
              oauth: {
                clientId: 'client',
                clientSecret: 'secret',
                tokenEndpointAuthMethod: 'client_secret_basic',
                scopes: ['read'],
              },
            },
      document: {
        openapi: '3.1.0',
        info: { title: 'OAuth API', version: '1' },
        components: mode === 'public' ? {} : { securitySchemes: { oauth: scheme } },
        paths: {
          [path]: {
            get: {
              security: mode === 'public' ? [] : [{ oauth: ['read'] }],
              responses: { '200': { description: 'Result' } },
            },
          },
        },
      },
    },
  });
  const tool = (await h.services.connections.discover(account.ownerId, connection.id))[0]!;
  const context = await h.services.connections.context(account.ownerId, connection.id);
  const call = (signal?: AbortSignal) =>
    h.services.invocations.call({
      ownerId: account.ownerId,
      toolId: tool.id,
      arguments: {},
      signal,
    });
  return { account, context, call };
}
test.each(['clientCredentials', 'oidc'] as const)(
  'OpenAPI %s uses real token exchange, explicit Basic auth and serialized expiry refresh',
  async (mode) => {
    const { context, call } = await setup(mode);
    const beforeTokens = tokens;
    if (mode === 'oidc') {
      const start = await h.services.apiOAuth.start(context, 'oauth');
      const state = new URL(start.authorizationUrl).searchParams.get('state')!;
      await h.services.apiOAuth.complete(context, 'oauth', {
        code: 'real-code',
        state,
        issuer: origin,
      });
    }
    const beforeCalls = dispatched;
    await call();
    await new Promise<void>((resolve) => setTimeout(resolve, 1100));
    await Promise.all(Array.from({ length: 4 }, () => call()));
    expect(tokens - beforeTokens).toBe(2);
    expect(dispatched - beforeCalls).toBe(5);
  },
);
test('revocation during OpenAPI authorization exchange rejects late credentials', async () => {
  const { context } = await setup('oidc');
  const start = await h.services.apiOAuth.start(context, 'oauth');
  const state = new URL(start.authorizationUrl).searchParams.get('state')!;
  const complete = h.services.apiOAuth.complete(context, 'oauth', {
    code: 'delayed',
    state,
    issuer: origin,
  });
  const rejected = expect(complete).rejects.toThrow(/撤销/);
  await vi.waitFor(() => expect(exchangeStarted).toBe(true));
  await h.services.apiOAuth.revoke(context, 'oauth');
  releaseExchange!();
  await rejected;
  expect((await h.services.apiOAuth.status(context, 'oauth')).authorized).toBe(false);
});
test('OpenAPI cancellation aborts the actual HTTP request without dispatching again', async () => {
  const { call } = await setup('public');
  const before = dispatched;
  const abort = new AbortController();
  const request = call(abort.signal);
  const rejected = expect(request).rejects.toThrow();
  await vi.waitFor(() => expect(dispatched - before).toBe(1));
  abort.abort();
  await rejected;
  await vi.waitFor(() => expect(cancelled).toBe(1));
  expect(dispatched - before).toBe(1);
});

test('OpenAPI browser callback returns to the connection after discovery without API dispatch', async () => {
  const { account, context } = await setup('oidc');
  const root = `/connections/${context.id}/openapi/oauth/oauth`;
  const start = await account.request(`${root}/start`, { method: 'POST' });
  expect(start.status).toBe(200);
  const authorization = new URL(
    ((await start.json()) as { authorizationUrl: string }).authorizationUrl,
  );
  const query = new URLSearchParams({
    code: 'browser-code',
    state: authorization.searchParams.get('state')!,
    iss: origin,
  });
  const before = dispatched;
  const callback = await account.request(`${root}/callback?${query}`);
  expect(callback.status).toBe(303);
  expect(callback.headers.get('Location')).toBe(
    `${h.config.WEB_ORIGIN}/connections#connection-${context.id}`,
  );
  expect((await h.services.apiOAuth.status(context, 'oauth')).authorized).toBe(true);
  expect(dispatched).toBe(before);
  expect((await account.request(`${root}/callback?${query}`)).status).toBeGreaterThanOrEqual(400);
  expect(dispatched).toBe(before);
});
