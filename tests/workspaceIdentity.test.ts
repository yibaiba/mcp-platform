import { beforeAll, afterAll, expect, test } from 'vitest';
import { resolve } from 'node:path';
import { harness } from './harness.js';
import { fixtureMcp } from './fixtureMcp.js';
import {
  withExecution,
  PLATFORM_CAPABILITIES,
} from '../apps/server/src/modules/mcp/executionContext.js';
let h: Awaited<ReturnType<typeof harness>>;
let upstream: Awaited<ReturnType<typeof fixtureMcp>>;
const sentCredentials: (string | null)[] = [];
beforeAll(async () => {
  h = await harness();
  upstream = await fixtureMcp({
    onRequest: (request) => sentCredentials.push(request.headers.get('Authorization')),
  });
});
afterAll(async () => {
  await h?.close();
  await upstream?.close();
});
test('two Agent dedicated HTTP identities strip shared credentials and remain stable across key rotation and entries', async () => {
  const account = await h.signup();
  const connection = await h.services.connections.create(account.ownerId, {
    name: 'HTTP identity',
    adapter: 'direct',
    transport: 'http',
    mode: 'existing',
    url: upstream.url,
    headers: { Authorization: 'Bearer shared-secret', 'X-Key': 'shared-key' },
    credentialHeaders: ['Authorization', 'X-Key'],
  });
  const profileA = (await h.services.profiles.save(account.ownerId, {
    name: 'A',
    connectionIdentities: { [connection.id]: 'profile' },
  }))!;
  const profileB = (await h.services.profiles.save(account.ownerId, {
    name: 'B',
    connectionIdentities: { [connection.id]: 'profile' },
  }))!;
  const ctx = (profileId: string, identity: string, entry: 'pi' | 'gateway') => ({
    ownerId: account.ownerId,
    profileId,
    identity,
    entry,
    sessionId: identity,
    capabilities: PLATFORM_CAPABILITIES,
  });
  const a = await withExecution(ctx(profileA.id, 'key-a', 'gateway'), () =>
    h.services.connections.context(account.ownerId, connection.id),
  );
  const b = await withExecution(ctx(profileB.id, 'key-b', 'gateway'), () =>
    h.services.connections.context(account.ownerId, connection.id),
  );
  expect(a.config.headers.Authorization).toBeUndefined();
  expect(a.bindingId).not.toBe(b.bindingId);
  await expect(
    withExecution(ctx(profileA.id, 'key-a', 'gateway'), () =>
      h.services.connections.discover(account.ownerId, connection.id),
    ),
  ).rejects.toThrow('凭证');
  await h.services.connections.bindings.credentials(account.ownerId, a.bindingId!, {
    headers: { Authorization: 'Bearer agent-a', 'X-Key': 'key-a' },
  });
  await h.services.connections.bindings.credentials(account.ownerId, b.bindingId!, {
    headers: { Authorization: 'Bearer agent-b', 'X-Key': 'key-b' },
  });
  await expect(
    h.services.connections.bindings.credentials(account.ownerId, a.bindingId!, {
      revision: 1,
      headers: { Authorization: 'Bearer stale' },
    }),
  ).rejects.toThrow('已变化');
  for (const profile of [profileA, profileB])
    await withExecution(ctx(profile.id, profile.id, 'gateway'), async () => {
      const [tool] = await h.services.connections.discover(account.ownerId, connection.id);
      await h.services.profiles.save(
        account.ownerId,
        { name: profile.name, toolIds: [tool!.id] },
        profile.id,
      );
      await h.services.invocations.call({
        ownerId: account.ownerId,
        profileId: profile.id,
        toolId: tool!.id,
        arguments: { message: 'dedicated HTTP' },
      });
    });
  expect(sentCredentials).toContain('Bearer agent-a');
  expect(sentCredentials).toContain('Bearer agent-b');
  expect(sentCredentials).not.toContain('Bearer shared-secret');
  const rotated = await withExecution(ctx(profileA.id, 'new-key', 'pi'), () =>
    h.services.connections.context(account.ownerId, connection.id),
  );
  expect(rotated.bindingId).toBe(a.bindingId);
  expect(rotated.sessionId).not.toBe(a.sessionId);
  expect(rotated.config.headers.Authorization).toBe('Bearer agent-a');
  const bound = await account.request(
    `/connections/${connection.id}/bindings/${a.bindingId}/oauth`,
  );
  expect(bound.status).toBe(200);
  const other = await h.signup();
  expect(
    (await other.request(`/connections/${connection.id}/bindings/${a.bindingId}/oauth`)).status,
  ).toBe(404);
  const listing = await (await account.request('/profiles')).text();
  expect(listing).not.toContain('agent-a');
  expect(listing).not.toContain('shared-secret');
});
test('dedicated stdio environments execute independently on the selected connection without inheriting shared identity fields', async () => {
  const account = await h.signup();
  const connection = await h.services.connections.create(account.ownerId, {
    name: 'stdio identity',
    adapter: 'direct',
    transport: 'stdio',
    mode: 'managed',
    command: process.execPath,
    args: ['--import', 'tsx', resolve('tests/fixtureStdio.mts')],
    env: { MCP_TEST_MARKER: 'shared' },
    credentialEnv: ['MCP_TEST_MARKER'],
  });
  const profiles = await Promise.all(
    ['A', 'B'].map((name) =>
      h.services.profiles.save(account.ownerId, {
        name,
        connectionIdentities: { [connection.id]: 'profile' },
      }),
    ),
  );
  const markers: string[] = [];
  for (const profile of profiles)
    await withExecution(
      {
        ownerId: account.ownerId,
        profileId: profile!.id,
        identity: `pi:${profile!.id}`,
        entry: 'dashboard',
        sessionId: profile!.id,
        capabilities: PLATFORM_CAPABILITIES,
      },
      async () => {
        const context = await h.services.connections.context(account.ownerId, connection.id);
        await expect(
          h.services.connections.discover(account.ownerId, connection.id),
        ).rejects.toThrow('凭证');
        await h.services.connections.bindings.credentials(account.ownerId, context.bindingId!, {
          env: { MCP_TEST_MARKER: profile!.name },
        });
        const [tool] = await h.services.connections.discover(account.ownerId, connection.id);
        await h.services.profiles.save(
          account.ownerId,
          { name: profile!.name, toolIds: [tool!.id] },
          profile!.id,
        );
        const result = await h.services.invocations.call({
          ownerId: account.ownerId,
          profileId: profile!.id,
          toolId: tool!.id,
          arguments: { message: 'identity' },
        });
        markers.push(String(result.structuredContent!.marker));
      },
    );
  expect(markers).toEqual(['A', 'B']);
});
test('credential selection separates bindings after key changes while omitted new identity settings preserve existing behavior', async () => {
  const account = await h.signup();
  const connection = await h.services.connections.create(account.ownerId, {
    name: 'credential identity',
    adapter: 'direct',
    transport: 'http',
    mode: 'existing',
    url: upstream.url,
  });
  const profile = (await h.services.profiles.save(account.ownerId, {
    name: 'per-key',
    connectionIdentities: { [connection.id]: 'credential' },
  }))!;
  const context = (identity: string) => ({
    ownerId: account.ownerId,
    profileId: profile.id,
    credentialId: identity,
    identity,
    entry: 'gateway' as const,
    sessionId: identity,
    capabilities: {},
  });
  const a = await withExecution(context('a'), () =>
    h.services.connections.context(account.ownerId, connection.id),
  );
  const b = await withExecution(context('b'), () =>
    h.services.connections.context(account.ownerId, connection.id),
  );
  expect(a.bindingId).not.toBe(b.bindingId);
  await h.services.profiles.save(account.ownerId, { name: 'renamed' }, profile.id);
  expect(
    (await h.services.profiles.owned(account.ownerId, profile.id)).connectionIdentities,
  ).toEqual(profile.connectionIdentities);
});
