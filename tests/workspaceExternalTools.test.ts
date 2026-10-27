import { afterAll, beforeAll, expect, test } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { Client as LegacyClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport as LegacyTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { describeTools } from '../apps/server/src/modules/agent-profiles/toolPresentation.js';
import { harness } from './harness.js';
import { fixtureMcp } from './fixtureMcp.js';

let h: Awaited<ReturnType<typeof harness>>;
let fixture: Awaited<ReturnType<typeof fixtureMcp>>;
beforeAll(async () => {
  h = await harness();
  fixture = await fixtureMcp();
});
afterAll(async () => {
  await h?.close();
  await fixture?.close();
});

async function connect(input: { profileId: string; token: string; legacy?: boolean }) {
  const url = new URL(`${h.baseURL}/mcp/${input.profileId}`);
  const requestInit = { headers: { Authorization: `Bearer ${input.token}` } };
  if (input.legacy) {
    const client = new LegacyClient({ name: 'external-artifacts', version: '1' });
    await client.connect(new LegacyTransport(url, { requestInit }));
    return client;
  }
  const client = new Client({ name: 'external-artifacts', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(url, { requestInit }));
  return client;
}
function payload(result: unknown) {
  const content = (result as { content: { type: string; text: string }[] }).content;
  expect(content[0]?.type).toBe('text');
  return JSON.parse(content[0]!.text);
}

test('external catalog describes only granted tools without changing stable IDs or exposing secrets', async () => {
  const account = await h.signup();
  const created = [];
  for (const name of ['私人资料', '团队资料', '未授权连接']) {
    const connection = await h.services.connections.create(account.ownerId, {
      name,
      adapter: 'direct',
      transport: 'http',
      mode: 'existing',
      url: fixture.url,
      headers: { Authorization: 'Bearer fixture-only-private-header' },
    });
    const [tool] = await h.services.connections.discover(account.ownerId, connection.id);
    created.push({ connection: { ...connection, name }, tool: tool! });
  }
  const profile = (await h.services.profiles.save(account.ownerId, {
    name: '资料助手',
    toolIds: created.slice(0, 2).map((item) => item.tool.id),
  }))!;
  const key = await h.services.profiles.issue(account.ownerId, profile.id);
  const client = await connect({ profileId: profile.id, token: key.token });
  try {
    const listed = (await client.listTools()).tools;
    expect(listed).toHaveLength(2);
    expect(listed.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(created.slice(0, 2).map((item) => item.tool.id)),
    );
    for (const tool of listed) {
      const source = created.find((item) => item.tool.id === tool.name)!;
      expect(tool.description).toContain('Echo for SDK integration');
      expect(tool.description).toContain(`连接 ${source.connection.name}`);
      expect(tool.description).toContain('执行位置 平台主机');
      expect(tool.title).toBe(`echo · ${source.connection.name}`);
      expect(tool.inputSchema).toEqual(source.tool.inputSchema);
    }
    expect(JSON.stringify(listed)).not.toMatch(/未授权连接|fixture-only-private-header/);
    expect(
      await client.callTool({ name: listed[0]!.name, arguments: { message: 'routed' } }),
    ).toMatchObject({ content: [{ type: 'text', text: 'routed' }] });
  } finally {
    await client.close();
  }
});

test('device descriptions use the selected device and profile identity while retaining upstream metadata', async () => {
  const account = await h.signup();
  const pairing = await h.services.devices.createPairing(account.ownerId, '工作 Mac');
  const device = await h.services.devices.pair(pairing.code);
  const connection = await h.services.connections.create(account.ownerId, {
    name: '本地文件',
    adapter: 'device',
    deviceId: device.deviceId,
    transport: 'stdio',
    mode: 'managed',
    command: 'node',
  });
  const profile = (await h.services.profiles.save(account.ownerId, {
    name: '设备助手',
    connectionIdentities: { [connection.id]: 'profile' },
  }))!;
  const definition = {
    title: '原服务标题',
    inputSchema: {},
    annotations: { readOnlyHint: true },
    _meta: { original: true },
  };
  // This checks presentation of stored catalog data; it does not execute an offline device.
  const [described] = await describeTools({
    db: h.db,
    profile,
    catalog: [
      {
        id: 'stable-tool-id',
        ownerId: account.ownerId,
        connectionId: connection.id,
        name: 'read_file',
        definition,
        available: true,
      },
    ],
  });
  expect(described?.definition).toMatchObject(definition);
  expect(described?.definition.description).toContain('执行位置 工作 Mac');
  expect(described?.definition.description).toContain('身份方式 Agent 专属身份');
  expect(JSON.stringify(described)).not.toContain(device.token);
});

test('long-term artifact permissions belong to the Profile while revoking a key affects that credential only', async () => {
  const account = await h.signup();
  const file = await h.services.artifacts.store(account.ownerId, {
    name: 'shared-report.txt',
    body: new Response('report').body,
  });
  const profile = (await h.services.profiles.save(account.ownerId, {
    name: '长期授权助手',
    artifactIds: [file.id],
  }))!;
  const a = await h.services.profiles.issue(account.ownerId, profile.id);
  const b = await h.services.profiles.issue(account.ownerId, profile.id);
  const client = await connect({ profileId: profile.id, token: a.token });
  const other = await connect({ profileId: profile.id, token: b.token });
  const read = {
    name: 'platform_artifacts_read',
    arguments: { id: file.id, offset: 0, length: file.size, encoding: 'utf8' },
  };
  try {
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
      'platform_artifacts_catalog',
      'platform_artifacts_read',
    ]);
    expect(payload(await client.callTool(read)).data).toBe('report');
    expect(payload(await other.callTool(read)).data).toBe('report');
    await h.services.profiles.revoke(account.ownerId, a.id);
    await expect(client.callTool(read)).rejects.toThrow();
    expect(payload(await other.callTool(read)).data).toBe('report');
  } finally {
    await client.close();
    await other.close();
  }
});

test.each([false, true])(
  'external artifact reads enforce credential scope and revocation (legacy=%s)',
  async (legacy) => {
    const account = await h.signup();
    const stranger = await h.signup();
    const text = '中文 report';
    const file = await h.services.artifacts.store(account.ownerId, {
      name: '报告.txt',
      body: new Response(text).body,
    });
    const hidden = await h.services.artifacts.store(account.ownerId, {
      name: '未授权.txt',
      body: new Response('hidden').body,
    });
    const foreign = await h.services.artifacts.store(stranger.ownerId, {
      name: 'foreign.txt',
      body: new Response('foreign').body,
    });
    const profile = (await h.services.profiles.save(account.ownerId, {
      name: '文件助手',
      requestable: { artifactIds: [file.id] },
    }))!;
    const a = await h.services.profiles.issue(account.ownerId, profile.id);
    const b = await h.services.profiles.issue(account.ownerId, profile.id);
    const otherProfile = (await h.services.profiles.save(account.ownerId, { name: '其他助手' }))!;
    expect(
      (
        await h.app.request(`/mcp/${otherProfile.id}`, {
          headers: { Authorization: `Bearer ${a.token}` },
        })
      ).status,
    ).toBe(401);
    const client = await connect({ profileId: profile.id, token: a.token, legacy });
    const other = await connect({ profileId: profile.id, token: b.token, legacy });
    const read = (id: string, extra = {}) => ({
      name: 'platform_artifacts_read',
      arguments: { id, offset: 0, length: file.size, ...extra },
    });
    try {
      expect((await client.listTools()).tools.map((tool) => tool.name)).toContain(
        'platform_artifacts_read',
      );
      expect(
        payload(await client.callTool({ name: 'platform_artifacts_catalog', arguments: {} })),
      ).toEqual([]);
      await expect(client.callTool(read(file.id))).rejects.toThrow();
      const request = payload(
        await client.callTool({
          name: 'platform_permissions_request',
          arguments: {
            permissions: { artifactIds: [file.id] },
            reason: '读取用户选定报告',
            idempotencyKey: 'report',
          },
        }),
      );
      await h.services.requests.decide(account.ownerId, request.id, {
        decision: 'approved',
        permissions: { artifactIds: [file.id] },
      });
      const catalog = payload(
        await client.callTool({ name: 'platform_artifacts_catalog', arguments: {} }),
      );
      expect(catalog).toHaveLength(1);
      expect(catalog[0]).toMatchObject({
        id: file.id,
        name: file.name,
        size: file.size,
        sha256: file.sha256,
        authorizationRequired: true,
      });
      expect(JSON.stringify(catalog)).not.toContain(a.token);
      expect(payload(await client.callTool(read(file.id, { encoding: 'utf8' })))).toMatchObject({
        data: text,
        encoding: 'utf8',
        length: file.size,
      });
      expect(payload(await client.callTool(read(file.id)))).toMatchObject({
        data: Buffer.from(text).toString('base64'),
        encoding: 'base64',
      });
      await expect(client.callTool(read(file.id, { length: 1, encoding: 'utf8' }))).rejects.toThrow(
        'UTF-8',
      );
      await expect(
        client.callTool(read(file.id, { profileId: otherProfile.id })),
      ).rejects.toThrow();
      for (const id of [hidden.id, foreign.id])
        await expect(client.callTool(read(id))).rejects.toThrow();
      await expect(other.callTool(read(file.id))).rejects.toThrow();
      expect(
        payload(await other.callTool({ name: 'platform_artifacts_catalog', arguments: {} })),
      ).toEqual([]);
      const download = await h.app.request(catalog[0].downloadPath, {
        headers: { Authorization: `Bearer ${a.token}` },
      });
      expect(await download.text()).toBe(text);
      expect((await h.app.request(catalog[0].downloadPath)).status).toBe(401);
      const [grant] = await h.services.requests.grants(account.ownerId);
      await h.services.requests.revoke(account.ownerId, grant!.id);
      await expect(client.callTool(read(file.id))).rejects.toThrow();
      expect(
        payload(await client.callTool({ name: 'platform_artifacts_catalog', arguments: {} })),
      ).toEqual([]);
      expect(
        (
          await h.app.request(catalog[0].downloadPath, {
            headers: { Authorization: `Bearer ${a.token}` },
          })
        ).status,
      ).toBe(403);
    } finally {
      await client.close();
      await other.close();
    }
  },
);
