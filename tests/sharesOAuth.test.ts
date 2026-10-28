import { afterAll, beforeAll, expect, test } from 'vitest';
import { eq } from 'drizzle-orm';
import { user } from '../packages/db/src/index.js';
import { harness } from './harness.js';
import { oauthFixture } from './fixtureOAuth.js';
let h: Awaited<ReturnType<typeof harness>>;
beforeAll(async () => {
  h = await harness();
});
afterAll(async () => {
  await h?.close();
});

test('delegated OAuth refresh is serialized with owner calls; independent OAuth uses recipient storage and subject', async () => {
  const fixture = await oauthFixture({ multipleIdentities: true });
  try {
    const owner = await h.signup(),
      delegated = await h.signup(),
      independent = await h.signup();
    const config = {
      name: 'shared OAuth',
      adapter: 'direct',
      transport: 'http',
      mode: 'existing',
      url: `${fixture.origin}/mcp`,
      oauth: { clientId: 'shared-test' },
    };
    const connection = await h.services.connections.create(owner.ownerId, config);
    const context = await h.services.connections.context(owner.ownerId, connection.id);
    const started = await h.services.upstreamOAuth.start(context);
    await h.services.upstreamOAuth.complete(context, {
      code: 'owner',
      state: new URL(started.authorizationUrl!).searchParams.get('state')!,
    });
    const tools = await h.services.connections.discover(owner.ownerId, connection.id);
    for (const [recipient, mode] of [
      [delegated, 'owner'],
      [independent, 'independent'],
    ] as const) {
      const [row] = await h.db.select().from(user).where(eq(user.id, recipient.ownerId));
      const grant = await h.services.shares.save(owner.ownerId, connection.id, {
        recipientEmail: row!.email,
        credentialMode: mode,
        toolIds: tools.map((tool) => tool.id),
      });
      if (mode === 'independent')
        await h.services.shares.configure(recipient.ownerId, grant.id, config);
    }
    const delegateContext = await h.services.connections.context(delegated.ownerId, connection.id);
    const independentContext = await h.services.connections.context(
      independent.ownerId,
      connection.id,
    );
    await expect(h.services.upstreamOAuth.status(delegateContext)).rejects.toMatchObject({
      code: 'SHARE_OWNER_CREDENTIALS',
    });
    expect((await h.services.upstreamOAuth.status(independentContext)).authorized).toBe(false);
    const ownProvider = h.services.upstreamOAuth.provider(context);
    await ownProvider.saveTokens({ ...(await ownProvider.tokens())!, expires_in: 0 });
    const before = fixture.refreshes();
    const headers = await Promise.all(
      [context, delegateContext, context, delegateContext].map((c) =>
        h.services.upstreamOAuth.headers(c),
      ),
    );
    expect(fixture.refreshes() - before).toBe(1);
    expect(new Set(headers.map((value) => value.Authorization)).size).toBe(1);
    const independentStart = await h.services.upstreamOAuth.start(independentContext);
    await h.services.upstreamOAuth.complete(independentContext, {
      code: 'recipient',
      state: new URL(independentStart.authorizationUrl!).searchParams.get('state')!,
    });
    expect(await h.services.upstreamOAuth.provider(independentContext).tokens()).not.toEqual(
      await ownProvider.tokens(),
    );
    for (const recipient of [delegated, independent])
      await expect(
        h.services.invocations.call({
          ownerId: recipient.ownerId,
          toolId: tools[0]!.id,
          arguments: {},
        }),
      ).resolves.toBeDefined();
    await h.services.connections.closeBinding(context);
    await h.services.upstreamOAuth.revoke(context);
    expect((await h.services.upstreamOAuth.status(independentContext)).authorized).toBe(true);
    await expect(
      h.services.invocations.call({
        ownerId: independent.ownerId,
        toolId: tools[0]!.id,
        arguments: {},
      }),
    ).resolves.toBeDefined();
    expect(h.services.connections.sessions(delegated.ownerId, {})).toEqual([]);
  } finally {
    await h.services.connections.shutdown();
    await fixture.close();
  }
});

test('real Pi recipient worker reuses explicitly shared owner OAuth file without receiving management rights', async () => {
  const fixture = await oauthFixture();
  try {
    const owner = await h.signup(),
      recipient = await h.signup();
    const connection = await h.services.connections.create(owner.ownerId, {
      name: 'Pi shared OAuth',
      adapter: 'pi',
      transport: 'http',
      mode: 'existing',
      url: `${fixture.origin}/mcp`,
      oauth: { clientId: 'pi-shared-test' },
    });
    const context = await h.services.connections.context(owner.ownerId, connection.id);
    const start = (await h.services.pi.action(context, { action: 'auth-start' })) as {
      details: { authorizationUrl: string };
    };
    const authorization = new URL(start.details.authorizationUrl);
    const redirect = new URL(authorization.searchParams.get('redirect_uri')!);
    redirect.searchParams.set('state', authorization.searchParams.get('state')!);
    redirect.searchParams.set('code', 'pi-owner');
    await h.services.pi.action(context, {
      action: 'auth-complete',
      args: { redirectUrl: redirect.href },
    });
    const tools = await h.services.connections.discover(owner.ownerId, connection.id);
    const [row] = await h.db.select().from(user).where(eq(user.id, recipient.ownerId));
    const grant = await h.services.shares.save(owner.ownerId, connection.id, {
      recipientEmail: row!.email,
      credentialMode: 'owner',
      toolIds: tools.map((tool) => tool.id),
    });
    await expect(
      h.services.invocations.call({
        ownerId: recipient.ownerId,
        toolId: tools[0]!.id,
        arguments: {},
      }),
    ).resolves.toBeDefined();
    await h.services.shares.revoke(owner.ownerId, grant.id);
    await expect(
      h.services.invocations.call({ ownerId: owner.ownerId, toolId: tools[0]!.id, arguments: {} }),
    ).resolves.toBeDefined();
  } finally {
    await h.services.connections.shutdown();
    await h.services.pi.close();
    await fixture.close();
  }
}, 30_000);
