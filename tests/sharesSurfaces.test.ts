import { afterAll, beforeAll, expect, test } from 'vitest';
import { eq } from 'drizzle-orm';
import { user } from '../packages/db/src/index.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { harness } from './harness.js';
import { fixtureConnector } from './fixtureConnector.js';
import { fixtureMcp } from './fixtureMcp.js';
import { fixtureApp } from './fixtureApp.js';
import {
  withExecution,
  PLATFORM_CAPABILITIES,
} from '../apps/server/src/modules/mcp/executionContext.js';
import { disableUserRuntime } from '../apps/server/src/modules/users/userRuntime.js';

let h: Awaited<ReturnType<typeof harness>>;
let owner: Awaited<ReturnType<typeof h.signup>>;
let receiver: typeof owner;
let connector: Awaited<ReturnType<typeof fixtureConnector>>;
let upstream: Awaited<ReturnType<typeof fixtureMcp>>;
let app: Awaited<ReturnType<typeof fixtureApp>>;
beforeAll(async () => {
  h = await harness();
  owner = await h.signup();
  receiver = await h.signup();
  connector = await fixtureConnector(h, owner.ownerId);
  upstream = await fixtureMcp();
  app = await fixtureApp();
});
afterAll(async () => {
  await connector?.close();
  await h?.close();
  await upstream?.close();
  await app?.close();
});
async function share(connectionId: string, toolIds: string[], contentIds: string[] = []) {
  const [recipient] = await h.db.select().from(user).where(eq(user.id, receiver.ownerId));
  return h.services.shares.save(owner.ownerId, connectionId, {
    recipientEmail: recipient!.email,
    credentialMode: 'owner',
    toolIds,
    contentIds,
  });
}

test('real Go HMAC channel executes shared calls with two recipient keys without sharing device management', async () => {
  const connection = await h.services.connections.create(owner.ownerId, {
    name: 'owner device',
    adapter: 'device',
    transport: 'http',
    mode: 'existing',
    url: upstream.url,
    deviceId: connector.deviceId,
  });
  const tools = await h.services.connections.discover(owner.ownerId, connection.id);
  const grant = await share(
    connection.id,
    tools.map((tool) => tool.id),
  );
  const profile = (await h.services.profiles.save(receiver.ownerId, {
    name: 'shared Go',
    toolIds: tools.map((tool) => tool.id),
  }))!;
  const keys = await Promise.all(
    [1, 2].map(() => h.services.profiles.issue(receiver.ownerId, profile.id)),
  );
  const clients = keys.map(() => new Client({ name: 'shared-Go-client', version: '1' }));
  try {
    await Promise.all(
      clients.map((client, index) =>
        client.connect(
          new StreamableHTTPClientTransport(new URL(`${h.baseURL}/mcp/${profile.id}`), {
            requestInit: { headers: { Authorization: `Bearer ${keys[index]!.token}` } },
          }),
        ),
      ),
    );
    for (const client of clients) {
      const listed = (await client.listTools()).tools.map((tool) => tool.name);
      expect(listed).toContain('owner_device__echo');
      expect(listed).not.toContain(tools[0]!.id);
      expect(
        await client.callTool({ name: tools[0]!.id, arguments: { message: 'shared device' } }),
      ).toMatchObject({ structuredContent: { name: 'echo' } });
    }
    expect(
      h.services.connections.sessions(receiver.ownerId, { profileId: profile.id }),
    ).toHaveLength(2);
    expect(await (await receiver.request('/devices')).json()).toEqual([]);
    await expect(h.services.devices.owned(receiver.ownerId, connector.deviceId)).rejects.toThrow();
    await h.services.shares.revoke(owner.ownerId, grant.id);
    for (const client of clients)
      await expect(client.callTool({ name: tools[0]!.id, arguments: {} })).rejects.toThrow(
        /未授权|失效/,
      );
    await expect(
      h.services.invocations.call({ ownerId: owner.ownerId, toolId: tools[0]!.id, arguments: {} }),
    ).resolves.toBeDefined();
  } finally {
    await Promise.all(clients.map((client) => client.close()));
  }
});

test('Apps use the recipient profile intersection and end on share revocation without ending the owner view', async () => {
  const connection = await h.services.connections.create(owner.ownerId, {
    name: 'shared App',
    adapter: 'direct',
    transport: 'http',
    mode: 'existing',
    url: app.url,
  });
  const tools = await h.services.connections.discover(owner.ownerId, connection.id);
  const show = tools.find((tool) => tool.name === 'show')!;
  const action = tools.find((tool) => tool.name === 'app_action')!;
  const content = await h.services.content.catalog({ ownerId: owner.ownerId }, connection.id);
  const grant = await share(
    connection.id,
    [show.id, action.id],
    content.map((entry) => entry.id),
  );
  const profile = (await h.services.profiles.save(receiver.ownerId, {
    name: 'App receiver',
    toolIds: [show.id],
    contentIds: content.map((entry) => entry.id),
  }))!;
  const result = await withExecution(
    {
      ownerId: receiver.ownerId,
      profileId: profile.id,
      identity: 'dashboard',
      entry: 'dashboard',
      sessionId: 'dashboard',
      capabilities: PLATFORM_CAPABILITIES,
    },
    () =>
      h.services.invocations.call({
        ownerId: receiver.ownerId,
        profileId: profile.id,
        toolId: show.id,
        arguments: {},
      }),
  );
  const id = String(result._meta?.['platform/appSession']);
  expect(id).not.toBe('undefined');
  await expect(h.services.apps.view(receiver.ownerId, id)).resolves.toBeDefined();
  await expect(
    h.services.apps.call(receiver.ownerId, id, { name: action.name }),
  ).rejects.toMatchObject({ code: 'APP_TOOL_FORBIDDEN' });
  const ownResult = await h.services.invocations.call({
    ownerId: owner.ownerId,
    toolId: show.id,
    arguments: {},
  });
  const ownId = String(ownResult._meta?.['platform/appSession']);
  await h.services.shares.revoke(owner.ownerId, grant.id);
  await expect(
    h.services.apps.call(receiver.ownerId, id, { name: show.name }),
  ).rejects.toMatchObject({ code: 'APP_VIEW_ENDED' });
  await expect(h.services.apps.view(owner.ownerId, ownId)).resolves.toBeDefined();
  h.services.apps.close(owner.ownerId, ownId);
});

test('disabling a recipient closes shared sessions; disabling an owner removes all delegated capability access', async () => {
  const connection = await h.services.connections.create(owner.ownerId, {
    name: 'disable sharing',
    adapter: 'direct',
    transport: 'http',
    mode: 'existing',
    url: upstream.url,
  });
  const tools = await h.services.connections.discover(owner.ownerId, connection.id);
  await share(
    connection.id,
    tools.map((tool) => tool.id),
  );
  await h.services.connections.discover(receiver.ownerId, connection.id);
  expect(h.services.connections.sessions(receiver.ownerId, {})).not.toHaveLength(0);
  await h.db.update(user).set({ enabled: false }).where(eq(user.id, receiver.ownerId));
  await disableUserRuntime({ db: h.db, services: h.services, ownerId: receiver.ownerId });
  expect(h.services.connections.sessions(receiver.ownerId, {})).toEqual([]);
  await expect(
    h.services.connections.discover(receiver.ownerId, connection.id),
  ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  await h.db.update(user).set({ enabled: true }).where(eq(user.id, receiver.ownerId));
  await h.db.update(user).set({ enabled: false }).where(eq(user.id, owner.ownerId));
  await disableUserRuntime({ db: h.db, services: h.services, ownerId: owner.ownerId });
  expect(await h.services.shares.permitted(receiver.ownerId, 'toolIds', [tools[0]!.id])).toEqual(
    [],
  );
  await expect(
    h.services.connections.discover(receiver.ownerId, connection.id),
  ).rejects.toMatchObject({ code: 'NOT_FOUND' });
});
