import { oauthFixture } from './fixtureOAuth.js';
import { withExecution } from '../apps/server/src/modules/mcp/executionContext.js';
import { afterAll, beforeAll, expect, test } from 'vitest';
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
  const callback = `${h.baseURL}/api/v1/connections/${connection.id}/oauth/callback`;
  expect((await h.services.upstreamOAuth.status(context)).redirectUrl).toBe(callback);
  const start = await h.services.upstreamOAuth.start(context);
  expect(start.status).toBe('REDIRECT');
  expect(start.redirectUrl).toBe(callback);
  expect(new URL(start.authorizationUrl!).searchParams.get('redirect_uri')).toBe(callback);
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
  await expect(restarted.status({ ...context, ownerId: 'another-owner' })).rejects.toMatchObject({
    code: 'SHARE_OWNER_CREDENTIALS',
  });
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

test.each([
  { adapter: 'direct', scoped: false },
  { adapter: 'pi', scoped: false },
  { adapter: 'direct', scoped: true },
  { adapter: 'pi', scoped: true },
] as const)(
  '$adapter browser callback (binding=$scoped) completes discovery without business dispatch',
  async ({ adapter, scoped }) => {
    const fixture = await oauthFixture();
    let createdConnection: { ownerId: string; id: string } | undefined;
    try {
      const account = await h.signup();
      const other = await h.signup();
      const connection = await h.services.connections.create(account.ownerId, {
        name: 'automatic OAuth',
        adapter,
        transport: 'http',
        mode: 'existing',
        url: `${fixture.origin}/mcp`,
        oauth: { clientId: 'browser-test' },
      });
      const context = scoped
        ? await withExecution(
            {
              identity: 'test-agent',
              bindingIdentity: 'test-agent',
              entry: 'dashboard',
              sessionId: 'authorization',
              capabilities: {},
            },
            () => h.services.connections.context(account.ownerId, connection.id),
          )
        : await h.services.connections.context(account.ownerId, connection.id);
      const root = `/connections/${connection.id}${scoped ? `/bindings/${context.bindingId}` : ''}/oauth`;
      createdConnection = { ownerId: account.ownerId, id: connection.id };
      const started = await account.request(`${root}/start`, { method: 'POST' });
      expect(started.status).toBe(200);
      const result = (await started.json()) as {
        authorizationUrl?: string;
        details?: { authorizationUrl: string };
      };
      const authorization = new URL((result.authorizationUrl ?? result.details?.authorizationUrl)!);
      const callback = new URL(authorization.searchParams.get('redirect_uri')!);
      expect(callback.href).toBe(`${h.baseURL}/api/v1${root}/callback`);
      callback.searchParams.set('state', authorization.searchParams.get('state')!);
      callback.searchParams.set('code', 'browser-code');
      const path = callback.pathname.replace('/api/v1', '') + callback.search;
      expect((await other.request(path)).status).toBe(404);
      const completed = await account.request(path);
      expect(completed.status).toBe(303);
      expect(completed.headers.get('Location')).toBe(
        `${h.config.WEB_ORIGIN}/connections#connection-${connection.id}`,
      );
      expect((await h.services.connections.owned(account.ownerId, connection.id)).status).toBe(
        'connected',
      );
      expect((await h.services.connections.bindings.snapshot(context))?.tools[0]?.name).toBe(
        'echo',
      );
      expect(fixture.dispatches()).toBe(0);
      if (scoped) {
        const shared = await h.services.connections.context(account.ownerId, connection.id);
        expect(shared.bindingId).not.toBe(context.bindingId);
        expect(await h.services.connections.bindings.snapshot(shared)).toBeUndefined();
        if (adapter === 'direct')
          expect((await h.services.upstreamOAuth.status(shared)).authorized).toBe(false);
      }
      const replay = await account.request(path);
      expect(replay.status).toBeGreaterThanOrEqual(400);
      expect(fixture.dispatches()).toBe(0);
    } finally {
      if (createdConnection)
        await h.services.connections.close(createdConnection.ownerId, createdConnection.id);
      await h.services.pi.close();
      await fixture.close();
    }
  },
);
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
}, 30_000);

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
