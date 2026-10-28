import { afterAll, beforeAll, expect, test } from 'vitest';
import { harness } from './harness.js';
import { fixtureMcp } from './fixtureMcp.js';
import { oauthFixture } from './fixtureOAuth.js';
import { fixtureConnector } from './fixtureConnector.js';
let h: Awaited<ReturnType<typeof harness>>;
beforeAll(async () => {
  h = await harness();
});
afterAll(async () => {
  await h?.close();
});

test('the real OAuth completion route resolves a pending manifest without applying it again', async () => {
  const account = await h.signup();
  const fixture = await oauthFixture();
  try {
    const result = await h.services.manifests.apply(account.ownerId, {
      declaration: {
        version: 1,
        name: 'oauth',
        connections: {
          protected: {
            config: {
              name: 'Protected',
              adapter: 'direct',
              transport: 'http',
              mode: 'existing',
              url: `${fixture.origin}/mcp`,
              oauth: { clientId: 'template-test' },
            },
          },
        },
        profiles: { agent: { name: 'Agent', tools: [{ connection: 'protected', name: 'echo' }] } },
      },
    });
    expect(result.status).not.toBe('ready');
    const id = result.entries.find((entry) => entry.kind === 'connection')!.objectId!;
    const started = await account.request(`/connections/${id}/oauth/start`, { method: 'POST' });
    expect(started.status).toBe(200);
    const { authorizationUrl } = (await started.json()) as { authorizationUrl: string };
    const context = await h.services.connections.context(account.ownerId, id);
    const redirect = new URL(h.services.upstreamOAuth.provider(context).redirectUrl);
    redirect.searchParams.set('state', new URL(authorizationUrl).searchParams.get('state')!);
    redirect.searchParams.set('code', 'accepted');
    const completed = await account.request(`/connections/${id}/oauth/complete`, {
      method: 'POST',
      body: JSON.stringify({ redirectUrl: redirect.href }),
    });
    expect(completed.status).toBe(200);
    await expect
      .poll(async () => (await h.services.manifests.status(account.ownerId, 'oauth')).status)
      .toBe('ready');
    expect(fixture.dispatches()).toBe(0);
  } finally {
    await h.services.connections.shutdown();
    await fixture.close();
  }
});

test('a real Go connector reconnect advances a declared device connection and never dispatches a tool', async () => {
  const account = await h.signup();
  const connector = await fixtureConnector(h, account.ownerId);
  const fixture = await fixtureMcp();
  try {
    await connector.close();
    await expect.poll(() => h.services.broker.online(connector.deviceId)).toBe(false);
    const result = await h.services.manifests.apply(account.ownerId, {
      declaration: {
        version: 1,
        name: 'device',
        connections: {
          local: {
            deviceRef: 'desktop',
            config: {
              name: 'Device',
              adapter: 'device',
              transport: 'http',
              mode: 'existing',
              url: fixture.url,
            },
          },
        },
        profiles: { agent: { name: 'Agent', tools: [{ connection: 'local', name: 'echo' }] } },
      },
      mappings: { devices: { desktop: connector.deviceId } },
    });
    expect(result.status).not.toBe('ready');
    await connector.restart();
    await expect
      .poll(async () => (await h.services.manifests.status(account.ownerId, 'device')).status, {
        timeout: 8000,
      })
      .toBe('ready');
    expect(fixture.count()).toBe(0);
  } finally {
    await connector.close();
    await h.services.connections.shutdown();
    await fixture.close();
  }
}, 20_000);

test('shared declarations require explicit recipient and receiver mappings and honor independent identity', async () => {
  const owner = await h.signup(),
    receiver = await h.signup();
  const fixture = await fixtureMcp();
  try {
    const source = await h.services.manifests.apply(owner.ownerId, {
      declaration: {
        version: 1,
        name: 'source',
        connections: {
          echo: {
            config: {
              name: 'Source',
              adapter: 'direct',
              transport: 'http',
              mode: 'existing',
              url: fixture.url,
            },
          },
        },
        shares: { team: { connection: 'echo', recipientRef: 'member', tools: ['echo'] } },
      },
      mappings: { users: { member: receiver.ownerId } },
    });
    expect(source.status).toBe('ready');
    const grantId = source.entries.find((entry) => entry.kind === 'share')!.objectId!;
    const input = {
      declaration: {
        version: 1,
        name: 'receiver',
        connections: { team: { sharedRef: 'team' } },
        profiles: { agent: { name: 'Receiver', tools: [{ connection: 'team', name: 'echo' }] } },
      },
      mappings: { shares: { team: grantId } },
    };
    expect((await h.services.manifests.apply(receiver.ownerId, input)).status).toBe('pending');
    await h.services.shares.configure(receiver.ownerId, grantId, {
      name: 'Receiver identity',
      adapter: 'direct',
      transport: 'http',
      mode: 'existing',
      url: fixture.url,
    });
    const id = source.entries.find((entry) => entry.kind === 'connection')!.objectId!;
    await h.services.connections.discover(receiver.ownerId, id);
    await expect
      .poll(async () => (await h.services.manifests.status(receiver.ownerId, 'receiver')).status)
      .toBe('ready');
    await h.services.shares.revoke(owner.ownerId, grantId);
    const updated = await h.services.manifests.refresh(receiver.ownerId);
    expect(updated[0]!.status).toBe('pending');
    const profileId = updated[0]!.entries.find((entry) => entry.kind === 'profile')!.objectId!;
    await expect(h.services.profiles.catalog(receiver.ownerId, profileId)).rejects.toMatchObject({
      code: 'DEPLOYMENT_PENDING',
    });
  } finally {
    await h.services.connections.shutdown();
    await fixture.close();
  }
});
