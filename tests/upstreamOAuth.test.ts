import { withExecution } from '../apps/server/src/modules/mcp/executionContext.js';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { randomBytes } from 'node:crypto';
import { fixtureMcp } from './fixtureMcp.js';
import { harness } from './harness.js';
import { UpstreamOAuth } from '../apps/server/src/modules/authorizations/upstreamOAuth.js';
import { Vault } from '../apps/server/src/shared/crypto.js';
import { fixtureConnector } from './fixtureConnector.js';
let h: Awaited<ReturnType<typeof harness>>;
let upstream: Awaited<ReturnType<typeof oauthFixture>>;
beforeAll(async () => {
  h = await harness();
  upstream = await oauthFixture();
});
afterAll(async () => {
  await h?.close();
  await upstream?.close();
});

test('official SDK upstream OAuth callback, refresh, restart persistence and revocation isolation', async () => {
  const account = await h.signup();
  const connection = await h.services.connections.create(account.ownerId, {
    name: 'protected',
    adapter: 'direct',
    transport: 'http',
    mode: 'existing',
    url: `${upstream.origin}/mcp`,
    oauth: { clientId: 'registered-test' },
  });
  const context = await h.services.connections.context(account.ownerId, connection.id);
  const start = await h.services.upstreamOAuth.start(context);
  expect(start.status).toBe('REDIRECT');
  const state = new URL(start.authorizationUrl!).searchParams.get('state')!;
  await expect(
    h.services.upstreamOAuth.complete(context, { code: 'test-code', state: 'wrong' }),
  ).rejects.toThrow('授权状态');
  await h.services.upstreamOAuth.complete(context, { code: 'test-code', state });
  expect(await h.services.upstreamOAuth.provider(context).clientInformation()).toMatchObject({
    issuer: upstream.origin,
  });
  expect(await h.services.upstreamOAuth.provider(context).tokens()).toMatchObject({
    issuer: upstream.origin,
  });
  expect((await h.services.connections.discover(account.ownerId, connection.id))[0]?.name).toBe(
    'echo',
  );
  upstream.expire();
  await h.services.connections.discover(account.ownerId, connection.id);
  expect(upstream.refreshes()).toBe(1);
  const provider = h.services.upstreamOAuth.provider(context);
  await provider.saveTokens({ ...(await provider.tokens())!, expires_in: 0 });
  const headers = await Promise.all(
    Array.from({ length: 10 }, () => h.services.upstreamOAuth.headers(context)),
  );
  expect(new Set(headers.map((value) => value.Authorization)).size).toBe(1);
  expect(upstream.refreshes()).toBe(2);
  const restarted = new UpstreamOAuth({
    db: h.db,
    vault: new Vault(h.config.ENCRYPTION_KEY),
    publicUrl: h.baseURL,
    fetch,
  });
  expect((await restarted.status(context)).authorized).toBe(true);
  expect((await restarted.status({ ...context, ownerId: 'another-owner' })).authorized).toBe(false);
  const staleProvider = h.services.upstreamOAuth.provider(context);
  await h.services.connections.close(account.ownerId, connection.id);
  await h.services.upstreamOAuth.revoke(context);
  await expect(
    staleProvider.saveTokens({ access_token: 'late-response', token_type: 'Bearer' }),
  ).rejects.toThrow('已撤销');
  expect((await restarted.status(context)).authorized).toBe(false);
  await expect(
    h.services.upstreamOAuth.complete(context, { code: 'test-code', state }),
  ).rejects.toThrow('授权状态');
});

async function oauthFixture(options: { expiresIn?: number; multipleIdentities?: boolean } = {}) {
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
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await mcp.close();
    },
  };
}
test('device OAuth discovery, exchange and proactive refresh execute on the private Go authorization channel', async () => {
  const account = await h.signup();
  const device = await fixtureConnector(h, account.ownerId);
  try {
    const connection = await h.services.connections.create(account.ownerId, {
      name: 'Device OAuth',
      adapter: 'device',
      deviceId: device.deviceId,
      transport: 'http',
      mode: 'existing',
      url: `${upstream.origin}/mcp`,
      oauth: { clientId: 'device-registered' },
    });
    const context = await h.services.connections.context(account.ownerId, connection.id);
    const start = await h.services.upstreamOAuth.start(context);
    const state = new URL(start.authorizationUrl!).searchParams.get('state')!;
    await h.services.upstreamOAuth.complete(context, { code: 'device-code', state });
    const provider = h.services.upstreamOAuth.provider(context);
    await provider.saveTokens({
      ...(await provider.tokens()),
      access_token: 'expired-device-token',
      token_type: 'Bearer',
      expires_in: 0,
    });
    const before = upstream.refreshes();
    expect((await h.services.connections.discover(account.ownerId, connection.id))[0]?.name).toBe(
      'echo',
    );
    expect(upstream.refreshes() - before).toBe(1);
    expect(upstream.agents().some((agent) => agent.startsWith('Go-http-client/'))).toBe(true);
    expect((await h.services.connections.check(account.ownerId, connection.id)).healthy).toBe(true);
  } finally {
    await device.close();
  }
});

test('Pi owns OAuth exchange and proactive refresh while a rejected tool is dispatched only once', async () => {
  const fixture = await oauthFixture({ expiresIn: 0 });
  try {
    const account = await h.signup();
    const connection = await h.services.connections.create(account.ownerId, {
      name: 'Pi OAuth',
      adapter: 'pi',
      transport: 'http',
      mode: 'existing',
      url: `${fixture.origin}/mcp`,
      oauth: { clientId: 'pi-registered' },
    });
    const context = await h.services.connections.context(account.ownerId, connection.id);
    const start = (await h.services.pi.action(context, { action: 'auth-start' })) as {
      details: { authorizationUrl: string };
    };
    const authorization = new URL(start.details.authorizationUrl);
    const redirect = new URL(authorization.searchParams.get('redirect_uri')!);
    redirect.searchParams.set('state', authorization.searchParams.get('state')!);
    redirect.searchParams.set('code', 'pi-test-code');
    await h.services.pi.action(context, {
      action: 'auth-complete',
      args: { redirectUrl: redirect.href },
    });
    const tools = await h.services.connections.discover(account.ownerId, connection.id);
    fixture.expire();
    expect(
      await h.services.invocations.call({
        ownerId: account.ownerId,
        toolId: tools[0]!.id,
        arguments: { message: 'Pi refresh' },
      }),
    ).toMatchObject({ content: [{ type: 'text', text: 'Pi refresh' }] });
    expect(fixture.refreshes()).toBe(1);
    const before = fixture.dispatches();
    fixture.expire();
    await expect(
      h.services.invocations.call({
        ownerId: account.ownerId,
        toolId: tools[0]!.id,
        arguments: { message: 'Rejected' },
      }),
    ).rejects.toThrow(/授权被拒绝/);
    expect(fixture.dispatches() - before).toBe(1);
    expect(fixture.refreshes()).toBe(1);
  } finally {
    await h.services.pi.close();
    await fixture.close();
  }
});

test('Agent dedicated OAuth bindings keep two upstream accounts and per-entry sessions separate', async () => {
  const fixture = await oauthFixture({ multipleIdentities: true });
  const account = await h.signup();
  let connectionId: string | undefined;
  try {
    const connection = await h.services.connections.create(account.ownerId, {
      name: 'dedicated OAuth',
      adapter: 'direct',
      transport: 'http',
      mode: 'existing',
      url: `${fixture.origin}/mcp`,
      oauth: { clientId: 'registered-test' },
    });
    connectionId = connection.id;
    const profiles = await Promise.all(
      ['A', 'B'].map((name) =>
        h.services.profiles.save(account.ownerId, {
          name,
          connectionIdentities: { [connection.id]: 'profile' },
        }),
      ),
    );
    const contexts = [];
    for (const profile of profiles) {
      const context = await withExecution(
        {
          ownerId: account.ownerId,
          profileId: profile!.id,
          identity: `test:${profile!.id}`,
          entry: 'dashboard',
          sessionId: profile!.id,
          capabilities: {},
        },
        () => h.services.connections.context(account.ownerId, connection.id),
      );
      const started = await h.services.upstreamOAuth.start(context);
      await h.services.upstreamOAuth.complete(context, {
        code: 'test-code',
        state: new URL(started.authorizationUrl!).searchParams.get('state')!,
      });
      contexts.push(context);
    }
    let toolId = '';
    for (const context of contexts)
      await withExecution(
        {
          ownerId: account.ownerId,
          profileId: context.profileId!,
          identity: `test:${context.profileId}`,
          entry: 'dashboard',
          sessionId: context.profileId!,
          capabilities: {},
        },
        async () => {
          const discovered = await h.services.connections.discover(account.ownerId, connection.id);
          expect(discovered[0]?.name).toBe('echo');
          toolId = discovered[0]!.id;
        },
      );
    const [a, b] = contexts;
    expect(a!.bindingId).not.toBe(b!.bindingId);
    const aToken = (await h.services.upstreamOAuth.provider(a!).tokens())!.access_token;
    const bToken = (await h.services.upstreamOAuth.provider(b!).tokens())!.access_token;
    expect(aToken).not.toBe(bToken);
    const profileA = profiles[0]!;
    await h.services.profiles.save(
      account.ownerId,
      { name: profileA.name, requestable: { toolIds: [toolId], contentIds: [], artifactIds: [] } },
      profileA.id,
    );
    const key = await h.services.profiles.issue(account.ownerId, profileA.id);
    const pending = await withExecution(
      {
        ownerId: account.ownerId,
        profileId: profileA.id,
        credentialId: key.id,
        identity: key.id,
        entry: 'gateway',
        sessionId: 'approval',
        capabilities: {},
      },
      () =>
        h.services.requests.create(
          { ownerId: account.ownerId, profileId: profileA.id },
          {
            permissions: { toolIds: [toolId], contentIds: [], artifactIds: [] },
            reason: 'OAuth identity generation',
            idempotencyKey: 'oauth-generation',
          },
        ),
    );
    expect(
      (
        await account.request(
          `/connections/${connection.id}/bindings/${a!.bindingId}/oauth/start`,
          { method: 'POST' },
        )
      ).status,
    ).toBe(200);
    expect((await h.services.requests.owned(account.ownerId, pending.id)).status).toBe(
      'invalidated',
    );
    expect(
      (
        await account.request(`/connections/${connection.id}/bindings/${a!.bindingId}/oauth`, {
          method: 'DELETE',
        })
      ).status,
    ).toBe(200);
    expect((await h.services.upstreamOAuth.status(b!)).authorized).toBe(true);
    const headers = await h.services.upstreamOAuth.headers(b!);
    expect(headers.Authorization).toBe(`Bearer ${bToken}`);
  } finally {
    if (connectionId) await h.services.connections.close(account.ownerId, connectionId);
    await fixture.close();
  }
});
