import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { Client as LegacyClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport as LegacyTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  ResourceUpdatedNotificationSchema,
  PromptListChangedNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { fixtureCatalog } from './fixtureCatalog.js';
import { harness } from './harness.js';
import { scopedUri } from '../apps/server/src/modules/mcp/catalogEntries.js';
import { contentToolset } from '../apps/server/src/modules/pi-runtime/contentTools.js';

let h: Awaited<ReturnType<typeof harness>>;
let fixture: Awaited<ReturnType<typeof fixtureCatalog>>;
let account: Awaited<ReturnType<typeof h.signup>>;
beforeAll(async () => {
  h = await harness();
  fixture = await fixtureCatalog();
  account = await h.signup();
});
afterAll(async () => {
  await h?.close();
  await fixture?.close();
});

async function connection() {
  const connection = await h.services.connections.create(account.ownerId, {
    name: 'full catalog',
    adapter: 'direct',
    transport: 'http',
    mode: 'existing',
    url: fixture.url,
  });
  const tools = await h.services.connections.discover(account.ownerId, connection.id);
  const entries = (await h.services.content.catalog({ ownerId: account.ownerId })).filter(
    (entry) => entry.connectionId === connection.id,
  );
  const profile = (await h.services.profiles.save(account.ownerId, {
    name: 'full catalog',
    toolIds: tools.map((tool) => tool.id),
    contentIds: entries.map((entry) => entry.id),
  }))!;
  const key = await h.services.profiles.issue(account.ownerId, profile.id);
  return {
    connection,
    tools,
    entries,
    profile,
    key,
    url: new URL(`${h.baseURL}/mcp/${profile.id}`),
    headers: { Authorization: `Bearer ${key.token}` },
  };
}

test('modern upstream catalog pagination, metadata and isolated prompt/resource grants reach modern and legacy clients', async () => {
  const configured = await connection();
  const duplicate = await connection();
  expect(configured.tools[0]).toMatchObject({
    title: 'Echo title',
    annotations: { readOnlyHint: true },
    _meta: { fixture: 'preserved' },
    outputSchema: { required: ['message'] },
  });
  expect(configured.entries.filter((entry) => entry.kind === 'prompt')).toHaveLength(2);
  expect(configured.entries.filter((entry) => entry.kind === 'resource')).toHaveLength(2);
  const prompt = configured.entries.find((entry) => entry.name === 'review')!;
  const resource = configured.entries.find((entry) => entry.name === 'shared')!;
  const template = configured.entries.find((entry) => entry.kind === 'template')!;
  const client = new Client(
    { name: 'modern-test', version: '1' },
    { versionNegotiation: { mode: 'auto' } },
  );
  await client.connect(
    new StreamableHTTPClientTransport(configured.url, {
      requestInit: { headers: configured.headers },
    }),
  );
  try {
    expect(client.getNegotiatedProtocolVersion()).toBe('2026-07-28');
    expect((await client.listPrompts()).prompts.map((entry) => entry.name)).toContain(prompt.id);
    expect((await client.listResourceTemplates()).resourceTemplates[0]?.uriTemplate).toBe(
      scopedUri(configured.connection.id, template.locator),
    );
    expect(
      (await client.getPrompt({ name: prompt.id, arguments: { subject: 'topic' } })).messages[1]
        ?.content,
    ).toMatchObject({
      type: 'resource',
      resource: { uri: scopedUri(configured.connection.id, resource.locator) },
    });
    expect(
      (await client.readResource({ uri: scopedUri(configured.connection.id, 'note:///abc') }))
        .contents[0],
    ).toMatchObject({ uri: scopedUri(configured.connection.id, 'note:///abc') });
    await expect(
      client.readResource({ uri: scopedUri(duplicate.connection.id, resource.locator) }),
    ).rejects.toThrow(/未授权/);
    await expect(
      client.getPrompt({ name: duplicate.entries.find((entry) => entry.name === 'review')!.id }),
    ).rejects.toThrow(/未授权/);
    const progress: number[] = [];
    expect(
      await client.callTool(
        { name: configured.tools[0]!.id, arguments: { message: 'actual' } },
        { onprogress: (event) => progress.push(event.progress) },
      ),
    ).toMatchObject({ structuredContent: { message: 'actual' }, _meta: { fixture: 'raw result' } });
    expect(progress).toEqual([1]);
  } finally {
    await client.close();
  }
  const legacy = new LegacyClient({ name: 'legacy-test', version: '1' });
  await legacy.connect(
    new LegacyTransport(configured.url, { requestInit: { headers: configured.headers } }),
  );
  try {
    expect((await legacy.listResources()).resources).toHaveLength(2);
    expect(
      (await legacy.getPrompt({ name: prompt.id, arguments: { subject: 'legacy' } })).messages[0]
        ?.content,
    ).toMatchObject({ text: 'review:legacy' });
  } finally {
    await legacy.close();
  }
});

test('catalog and resource notifications are routed to legacy and modern subscribers, then revoked immediately', async () => {
  const configured = await connection();
  const uri = scopedUri(configured.connection.id, 'file:///shared.txt');
  const legacy = new LegacyClient({ name: 'legacy-watch', version: '1' });
  const modern = new Client(
    { name: 'modern-watch', version: '1' },
    { versionNegotiation: { mode: 'auto' } },
  );
  const events: string[] = [];
  legacy.setNotificationHandler(ResourceUpdatedNotificationSchema, (event) => {
    events.push(`legacy:${event.params.uri}`);
  });
  legacy.setNotificationHandler(PromptListChangedNotificationSchema, () => {
    events.push('legacy:prompts');
  });
  modern.setNotificationHandler('notifications/resources/updated', (event) => {
    events.push(`modern:${event.params.uri}`);
  });
  modern.setNotificationHandler('notifications/prompts/list_changed', () => {
    events.push('modern:prompts');
  });
  await legacy.connect(
    new LegacyTransport(configured.url, { requestInit: { headers: configured.headers } }),
  );
  await modern.connect(
    new StreamableHTTPClientTransport(configured.url, {
      requestInit: { headers: configured.headers },
    }),
  );
  try {
    await legacy.subscribeResource({ uri });
    const listen = await modern.listen({ resourceSubscriptions: [uri], promptsListChanged: true });
    await fixture.update('new value');
    await vi.waitFor(() =>
      expect(events).toEqual(expect.arrayContaining([`legacy:${uri}`, `modern:${uri}`])),
    );
    const before = events.length;
    await legacy.unsubscribeResource({ uri });
    await fixture.update('after unsubscribe');
    await vi.waitFor(() => expect(events.length).toBeGreaterThan(before));
    expect(events.slice(before)).not.toContain(`legacy:${uri}`);
    fixture.promptName('renamed');
    await fixture.changed('prompts');
    await vi.waitFor(() =>
      expect(events).toEqual(expect.arrayContaining(['legacy:prompts', 'modern:prompts'])),
    );
    expect(
      (await h.services.content.catalog({ ownerId: account.ownerId })).some(
        (entry) => entry.connectionId === configured.connection.id && entry.name === 'renamed',
      ),
    ).toBe(true);
    const response = await account.request(`/profiles/${configured.profile.id}`, {
      method: 'PUT',
      body: JSON.stringify({ name: 'revoked', toolIds: [], contentIds: [] }),
    });
    expect(response.status).toBe(200);
    await expect(modern.readResource({ uri })).rejects.toThrow(/未授权/);
    await listen.close();
  } finally {
    fixture.promptName('review');
    await legacy.close();
    await modern.close();
  }
});

test('Schema dialects validate real inputs without tolerating malformed schemas or replaying tool calls', async () => {
  for (const dialect of [
    'http://json-schema.org/draft-07/schema#',
    'https://json-schema.org/draft/2019-09/schema',
    'https://json-schema.org/draft/2020-12/schema',
  ]) {
    fixture.schema({
      type: 'object',
      $schema: dialect,
      properties: { message: { type: 'string' } },
    });
    const configured = await connection();
    const before = fixture.calls();
    await expect(
      h.services.invocations.call({
        ownerId: account.ownerId,
        toolId: configured.tools[0]!.id,
        arguments: { message: 5 },
      }),
    ).rejects.toThrow(/校验失败/);
    expect(fixture.calls()).toBe(before);
    await h.services.invocations.call({
      ownerId: account.ownerId,
      toolId: configured.tools[0]!.id,
      arguments: { message: 'valid' },
    });
    expect(fixture.calls()).toBe(before + 1);
  }
  fixture.schema({ type: 'object', properties: { invalid: { type: 'invalid' } } });
  await expect(connection()).rejects.toThrow(/无法编译/);
  fixture.schema({ type: 'object', properties: { message: { type: 'string' } } });
});

test('legal boolean schemas remain equivalent for legacy clients, while invalid output is reported without replay', async () => {
  fixture.schema({
    type: 'object',
    properties: { message: { type: 'string' }, allowed: true, forbidden: false },
  });
  const configured = await connection();
  const legacy = new LegacyClient({ name: 'boolean-schema-client', version: '1' });
  await legacy.connect(
    new LegacyTransport(configured.url, { requestInit: { headers: configured.headers } }),
  );
  try {
    const [tool] = (await legacy.listTools()).tools;
    expect(tool?.inputSchema.properties).toMatchObject({ allowed: {}, forbidden: { not: {} } });
    const before = fixture.calls();
    await expect(
      legacy.callTool({ name: tool!.name, arguments: { forbidden: 'anything' } }),
    ).rejects.toThrow(/校验失败/);
    expect(fixture.calls()).toBe(before);
    fixture.invalidOutput(true);
    await expect(
      legacy.callTool({ name: tool!.name, arguments: { message: 'once' } }),
    ).rejects.toThrow(/outputSchema/);
    expect(fixture.calls()).toBe(before + 1);
  } finally {
    fixture.invalidOutput(false);
    fixture.schema({ type: 'object', properties: { message: { type: 'string' } } });
    await legacy.close();
  }
});

test('built-in Pi content tools use current profile grants and reject cross-account grants', async () => {
  const configured = await connection();
  const access = { ownerId: account.ownerId, profileId: configured.profile.id };
  const toolset = await contentToolset(h.services.content, access);
  expect(toolset.tools).toHaveLength(3);
  const list = await toolset.call('platform_mcp_catalog', {});
  expect(JSON.parse(list.content[0]!.text)).toHaveLength(5);
  const prompt = configured.entries.find((entry) => entry.name === 'review')!;
  expect(
    (await toolset.call('platform_mcp_prompt', { id: prompt.id, arguments: { subject: 'Pi' } }))
      .content[0]?.text,
  ).toContain('review:Pi');
  const other = await h.signup();
  await expect(
    h.services.profiles.save(other.ownerId, { name: 'cross owner', contentIds: [prompt.id] }),
  ).rejects.toThrow(/不属于/);
  const uri = scopedUri(configured.connection.id, 'file:///shared.txt');
  await h.services.profiles.save(account.ownerId, { name: 'revoked' }, configured.profile.id);
  await expect(toolset.call('platform_mcp_resource', { uri })).rejects.toThrow(/未授权/);
  expect(JSON.parse((await toolset.call('platform_mcp_catalog', {})).content[0]!.text)).toEqual([]);
});

test('stopping an upstream closes resource subscribers without reopening it during cleanup', async () => {
  const configured = await connection();
  const uri = scopedUri(configured.connection.id, 'file:///shared.txt');
  const client = new LegacyClient({ name: 'stop-resource-client', version: '1' });
  await client.connect(
    new LegacyTransport(configured.url, { requestInit: { headers: configured.headers } }),
  );
  await client.subscribeResource({ uri });
  await h.services.connections.stop(account.ownerId, configured.connection.id);
  expect(
    (await h.services.connections.list(account.ownerId)).find(
      (row) => row.id === configured.connection.id,
    )?.status,
  ).toBe('stopped');
  await client.close();
  await h.services.connections.discover(account.ownerId, configured.connection.id);
  const resumed = new LegacyClient({ name: 'resumed-resource-client', version: '1' });
  const events: string[] = [];
  resumed.setNotificationHandler(ResourceUpdatedNotificationSchema, (event) => {
    events.push(event.params.uri);
  });
  await resumed.connect(
    new LegacyTransport(configured.url, { requestInit: { headers: configured.headers } }),
  );
  try {
    await resumed.subscribeResource({ uri });
    await fixture.update('resumed');
    await vi.waitFor(() => expect(events).toContain(uri));
    await resumed.unsubscribeResource({ uri });
  } finally {
    await resumed.close();
  }
});
