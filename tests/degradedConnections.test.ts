import { afterAll, beforeAll, expect, test } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { harness } from './harness.js';
import { fixtureMcp } from './fixtureMcp.js';
import { fixtureConnector } from './fixtureConnector.js';
import { setupProgress, setupStatus } from '../apps/web/src/features/onboarding/setupProgress.js';

let h: Awaited<ReturnType<typeof harness>>;
let healthy: Awaited<ReturnType<typeof fixtureMcp>>;
let doomed: Awaited<ReturnType<typeof fixtureMcp>> | undefined;
let connector: Awaited<ReturnType<typeof fixtureConnector>>;
let account: Awaited<ReturnType<typeof h.signup>>;
const ids = { healthy: '', doomed: '', device: '' };
const connectionIds = { healthy: '', doomed: '', device: '' };
let profileId = '';
let token = '';

beforeAll(async () => {
  h = await harness();
  healthy = await fixtureMcp({ instructions: 'healthy instructions' });
  doomed = await fixtureMcp({ instructions: 'doomed instructions' });
  account = await h.signup();
  connector = await fixtureConnector(h, account.ownerId);
  const add = async (name: keyof typeof ids, input: Record<string, unknown>) => {
    const connection = await h.services.connections.create(account.ownerId, {
      name,
      transport: 'http',
      mode: 'existing',
      ...input,
    });
    const [tool] = await h.services.connections.discover(account.ownerId, connection.id);
    ids[name] = tool!.id;
    connectionIds[name] = connection.id;
  };
  await add('healthy', { adapter: 'direct', url: healthy.url });
  await add('doomed', { adapter: 'direct', url: doomed.url });
  await add('device', { adapter: 'device', deviceId: connector.deviceId, url: healthy.url });
  const profile = (await h.services.profiles.save(account.ownerId, {
    name: 'degraded agent',
    toolIds: Object.values(ids),
  }))!;
  profileId = profile.id;
  token = (await h.services.profiles.issue(account.ownerId, profile.id)).token;
});
afterAll(async () => {
  await connector?.close();
  await h?.close();
  await healthy?.close();
  await doomed?.close();
});

async function agent() {
  const client = new Client({ name: 'degraded-test', version: '1' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${h.baseURL}/mcp/${profileId}`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  return client;
}

test('one stopped upstream and one offline device do not take down the Agent', async () => {
  const before = await agent();
  const names = new Map((await before.listTools()).tools.map((tool) => [tool.name, tool] as const));
  expect(names.size).toBe(3);
  await before.close();
  const exposed = await h.services.profiles.catalog(account.ownerId, profileId);
  const nameOf = (id: string) => exposed.find((tool) => tool.id === id)!.exposedName;

  // The upstream process dies and the platform notices (health check or a retry); the laptop sleeps.
  await doomed!.close();
  doomed = undefined;
  await expect(
    h.services.connections.discover(account.ownerId, connectionIds.doomed),
  ).rejects.toMatchObject({ code: 'CONNECTION_FAILED' });
  await connector.close();
  await expect.poll(() => h.services.broker.online(connector.deviceId)).toBe(false);

  // initialize still succeeds and keeps the healthy connection's instructions.
  const client = await agent();
  expect(client.getInstructions()).toContain('healthy instructions');
  const listed = (await client.listTools()).tools.map((tool) => tool.name);
  expect(listed).toEqual([nameOf(ids.healthy)]);
  expect(
    (await client.callTool({ name: nameOf(ids.healthy), arguments: { message: 'still here' } }))
      .content,
  ).toEqual([{ type: 'text', text: 'still here' }]);

  // A broken tool answers with a readable tool error that names the connection and next step.
  const down = await client.callTool({ name: nameOf(ids.doomed), arguments: { message: 'x' } });
  expect(down.isError).toBe(true);
  expect(JSON.stringify(down.content)).toContain('CONNECTION_UNAVAILABLE');
  expect(JSON.stringify(down.content)).toContain('「doomed」暂不可用');
  const offline = await client.callTool({ name: nameOf(ids.device), arguments: { message: 'x' } });
  expect(offline.isError).toBe(true);
  expect(JSON.stringify(offline.content)).toContain(
    '「device」所在设备「Capability connector」离线',
  );
  expect(JSON.stringify(offline.content)).toContain('重新运行安装命令');
  await client.close();

  // Both failures land in the call log with the culprit connection and a code.
  const calls = (await (await account.request('/calls?limit=20')).json()) as {
    connectionId: string;
    status: string;
    error: string | null;
    profileId: string | null;
    startedAt: string;
    endedAt: string | null;
  }[];
  const failed = (connectionId: string) =>
    calls.find((call) => call.connectionId === connectionId && call.status === 'failed');
  expect(failed(connectionIds.doomed)).toMatchObject({ profileId });
  expect(failed(connectionIds.doomed)?.error).toMatch(/^CONNECTION_FAILED: 「doomed」暂不可用/);
  expect(failed(connectionIds.device)?.error).toMatch(/^DEVICE_OFFLINE: 「device」所在设备/);
  for (const call of [failed(connectionIds.doomed)!, failed(connectionIds.device)!])
    expect(Date.parse(call.endedAt!)).toBeGreaterThanOrEqual(Date.parse(call.startedAt));
  expect(calls.some((call) => call.connectionId === connectionIds.healthy)).toBe(true);

  // The dashboard catalog keeps the broken tools, marked, instead of failing the whole page.
  const response = await account.request('/tools');
  expect(response.status).toBe(200);
  const tools = (await response.json()) as {
    id: string;
    unavailable?: { code: string; message: string };
  }[];
  expect(tools.find((tool) => tool.id === ids.healthy)?.unavailable).toBeUndefined();
  expect(tools.find((tool) => tool.id === ids.doomed)?.unavailable?.code).toBe('CONNECTION_FAILED');
  expect(tools.find((tool) => tool.id === ids.device)?.unavailable?.code).toBe('DEVICE_OFFLINE');
  const run = await account.request(`/tools/${ids.device}/call`, {
    method: 'POST',
    body: JSON.stringify({ arguments: { message: 'x' } }),
  });
  expect(run.status).toBe(503);

  // The overview cannot claim setup is complete while a connection is broken.
  const connections = (await (await account.request('/connections')).json()) as {
    id: string;
    status: string;
    deviceOffline: boolean;
  }[];
  expect(connections.find((row) => row.id === connectionIds.device)?.deviceOffline).toBe(true);
  expect(connections.find((row) => row.id === connectionIds.doomed)?.status).toBe('error');
  const keys = (await (await account.request('/profiles/keys/all')).json()) as {
    profileId: string;
    revoked: boolean;
  }[];
  const profiles = [
    {
      id: profileId,
      toolIds: Object.values(ids),
      contentIds: [],
      skillVersionIds: [],
      artifactIds: [],
    },
  ];
  const status = setupStatus({ connections, profiles, keys });
  expect(status.steps).toEqual([true, true, true]);
  expect(status.complete).toBe(false);
  expect(status.broken.map((row) => row.id).sort()).toEqual(
    [connectionIds.doomed, connectionIds.device].sort(),
  );

  // Coming back online restores the tool without touching the Agent configuration.
  await connector.restart();
  const recovered = await agent();
  expect((await recovered.listTools()).tools.map((tool) => tool.name).sort()).toEqual(
    [nameOf(ids.healthy), nameOf(ids.device)].sort(),
  );
  await recovered.close();
});

test('setup counts as complete only when every saved connection is usable', () => {
  const input = {
    profiles: [{ id: 'a', toolIds: ['t'], contentIds: [], skillVersionIds: [], artifactIds: [] }],
    keys: [{ profileId: 'a', revoked: false }],
  };
  const connected = { status: 'connected' };
  expect(setupProgress({ ...input, connections: [connected] })).toEqual([true, true, true]);
  expect(setupStatus({ ...input, connections: [connected] }).complete).toBe(true);
  expect(setupStatus({ ...input, connections: [connected, { status: 'error' }] }).complete).toBe(
    false,
  );
  expect(
    setupStatus({ ...input, connections: [{ status: 'connected', deviceOffline: true }] }),
  ).toMatchObject({ steps: [true, true, true], complete: false });
  // A deliberately stopped connection is not "broken".
  expect(
    setupStatus({ ...input, connections: [connected, { status: 'stopped', deviceOffline: true }] })
      .complete,
  ).toBe(true);
});
