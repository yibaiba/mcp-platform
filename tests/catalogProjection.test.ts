import { afterAll, beforeAll, expect, test } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { harness } from './harness.js';
import { fixtureMcp } from './fixtureMcp.js';
import { fixtureApp } from './fixtureApp.js';
import {
  withExecution,
  PLATFORM_CAPABILITIES,
} from '../apps/server/src/modules/mcp/executionContext.js';

let h: Awaited<ReturnType<typeof harness>>;
let upstream: Awaited<ReturnType<typeof fixtureMcp>>;
let apps: Awaited<ReturnType<typeof fixtureApp>>;
beforeAll(async () => {
  h = await harness();
  upstream = await fixtureMcp();
  apps = await fixtureApp();
});
afterAll(async () => {
  await h?.close();
  await upstream?.close();
  await apps?.close();
});

test.each(['direct', 'pi'] as const)(
  '%s exposes aliases and rejects hidden fields before the real upstream executes',
  async (adapter) => {
    const { ownerId } = await h.signup();
    const connection = await h.services.connections.create(ownerId, {
      name: 'projection',
      adapter,
      mode: 'existing',
      transport: 'http',
      url: upstream.url,
    });
    const [tool] = await h.services.connections.discover(ownerId, connection.id);
    const profile = (await h.services.profiles.save(ownerId, {
      name: 'catalog',
      toolIds: [tool!.id],
      catalog: {
        tools: {
          [tool!.id]: {
            alias: 'echo_public',
            description: 'Public echo',
            hiddenParameters: ['delay'],
          },
        },
      },
    }))!;
    const key = await h.services.profiles.issue(ownerId, profile.id);
    const client = new Client({ name: 'catalog-client', version: '1' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${h.baseURL}/mcp/${profile.id}`), {
        requestInit: { headers: { Authorization: `Bearer ${key.token}` } },
      }),
    );
    try {
      const [definition] = (await client.listTools()).tools;
      expect(definition).toMatchObject({ name: 'echo_public', description: 'Public echo' });
      expect(definition!.inputSchema.properties).not.toHaveProperty('delay');
      const before = upstream.count();
      await expect(
        client.callTool({ name: 'echo_public', arguments: { delay: 0 } }),
      ).rejects.toThrow(/隐藏参数/);
      await expect(client.callTool({ name: tool!.id, arguments: {} })).rejects.toThrow();
      await expect(
        h.services.invocations.call({
          ownerId,
          profileId: profile.id,
          toolId: tool!.id,
          arguments: { delay: undefined },
        }),
      ).rejects.toMatchObject({ code: 'HIDDEN_PARAMETER' });
      expect(upstream.count()).toBe(before);
      expect(
        await client.callTool({ name: 'echo_public', arguments: { message: 'renamed' } }),
      ).toMatchObject({ content: [{ type: 'text', text: 'renamed' }] });
      expect(upstream.count()).toBe(before + 1);
      await h.services.connections.discover(ownerId, connection.id);
      expect((await h.services.profiles.owned(ownerId, profile.id)).catalog).toEqual(
        profile.catalog,
      );
      expect((await h.services.profiles.potentialCatalog(ownerId, profile.id))[0]).toMatchObject({
        id: tool!.id,
        name: 'echo',
        exposedName: 'echo_public',
      });
      await expect(
        h.services.profiles.save(ownerId, {
          name: 'invalid',
          toolIds: [tool!.id],
          catalog: { tools: { [tool!.id]: { alias: 'platform_permissions_request' } } },
        }),
      ).rejects.toMatchObject({ code: 'CATALOG_NAME_CONFLICT' });
    } finally {
      await client.close();
    }
  },
  30_000,
);

test('App calls use Profile hidden parameters and content descriptions without changing source definitions', async () => {
  const { ownerId } = await h.signup();
  const connection = await h.services.connections.create(ownerId, {
    name: 'App',
    adapter: 'direct',
    mode: 'existing',
    transport: 'http',
    url: apps.url,
  });
  const tools = await h.services.connections.discover(ownerId, connection.id);
  const content = await h.services.content.catalog({ ownerId }, connection.id);
  const action = tools.find((tool) => tool.name === 'app_action')!;
  const profile = (await h.services.profiles.save(ownerId, {
    name: 'App catalog',
    toolIds: tools.map((tool) => tool.id),
    contentIds: content.map((entry) => entry.id),
    catalog: {
      tools: { [action.id]: { alias: 'app_public', hiddenParameters: ['internal'] } },
      content: { [content[0]!.id]: { description: 'Public App resource' } },
    },
  }))!;
  const result = await withExecution(
    {
      ownerId,
      profileId: profile.id,
      identity: 'dashboard',
      entry: 'dashboard',
      sessionId: 'dashboard',
      capabilities: PLATFORM_CAPABILITIES,
    },
    () =>
      h.services.invocations.call({
        ownerId,
        profileId: profile.id,
        toolId: tools.find((tool) => tool.name === 'show')!.id,
        arguments: {},
      }),
  );
  const id = result._meta!['platform/appSession'] as string;
  const before = apps.calls();
  for (const name of ['app_action', 'app_public', action.id])
    await expect(
      h.services.apps.call(ownerId, id, { name, arguments: { internal: true } }),
    ).rejects.toMatchObject({ code: 'HIDDEN_PARAMETER' });
  expect(apps.calls()).toBe(before);
  await h.services.apps.call(ownerId, id, { name: 'app_public' });
  expect(apps.calls()).toBe(before + 1);
  expect(
    (await h.services.content.catalog({ ownerId, profileId: profile.id }))[0]!.definition
      .description,
  ).toBe('Public App resource');
  expect(
    (await h.services.content.catalog({ ownerId }))[0]!.definition.description,
  ).toBeUndefined();
  h.services.apps.close(ownerId, id);
});
