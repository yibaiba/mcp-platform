import { afterAll, beforeAll, expect, test } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { resolve } from 'node:path';
import { realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { PiService } from '../apps/server/src/modules/pi-runtime/piService.js';
import { harness } from './harness.js';
import { fixtureMcp } from './fixtureMcp.js';
import { fixtureSseMcp } from './fixtureSseMcp.js';

let h: Awaited<ReturnType<typeof harness>>;
let fixture: Awaited<ReturnType<typeof fixtureMcp>>;
let sseFixture: Awaited<ReturnType<typeof fixtureSseMcp>>;
let account: Awaited<ReturnType<typeof h.signup>>;
beforeAll(async () => {
  h = await harness();
  fixture = await fixtureMcp();
  sseFixture = await fixtureSseMcp();
  account = await h.signup({ role: 'admin' });
});
afterAll(async () => {
  await h?.close();
  await fixture?.close();
  await sseFixture?.close();
});

test.each(['http', 'sse'] as const)(
  'Pi %s discovery, authorization status and calls work with Agent tasks disabled and no model',
  async (transport) => {
    expect(h.config.PI_ENABLED).toBe('false');
    expect(h.config.PI_MODEL_PROVIDER).toBeUndefined();
    expect(h.config.PI_MODEL_ID).toBeUndefined();
    const upstream = transport === 'sse' ? sseFixture : fixture;
    const created = await account.request('/connections', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Pi without inference',
        adapter: 'pi',
        transport,
        mode: 'existing',
        url: upstream.url,
      }),
    });
    expect(created.status).toBe(201);
    const connection = (await created.json()) as { id: string };
    const discovered = await account.request(`/connections/${connection.id}/discover`, {
      method: 'POST',
    });
    expect(discovered.status).toBe(200);
    const tools = (await discovered.json()) as { id: string; name: string }[];
    expect(tools.map((tool) => tool.name)).toEqual(['echo']);
    const status = await account.request(`/connections/${connection.id}/oauth`);
    expect(status.status).toBe(200);
    const called = await account.request(`/tools/${tools[0]!.id}/call`, {
      method: 'POST',
      body: JSON.stringify({ arguments: { message: 'no model required' } }),
    });
    expect(called.status).toBe(200);
    expect(await called.json()).toMatchObject({
      content: [{ type: 'text', text: 'no model required' }],
      structuredContent: { name: 'echo' },
    });
    await verifyExternalAgent(tools[0]!.id);
    // Platform call + readable-name call + legacy `t_` name call.
    expect(upstream.count()).toBe(3);
  },
  30_000,
);

test('platform direct connects to legacy SSE without a model', async () => {
  const connection = await h.services.connections.create(account.ownerId, {
    name: 'direct SSE',
    adapter: 'direct',
    transport: 'sse',
    mode: 'existing',
    url: sseFixture.url,
  });
  const tools = await h.services.connections.discover(account.ownerId, connection.id);
  expect(tools.map((tool) => tool.name)).toEqual(['echo']);
  expect(
    await h.services.invocations.call({
      ownerId: account.ownerId,
      toolId: tools[0]!.id,
      arguments: { message: 'direct SSE' },
    }),
  ).toMatchObject({ content: [{ type: 'text', text: 'direct SSE' }] });
});

test('Pi reports failure for the selected HTTP transport instead of accepting an SSE connection', async () => {
  const callsBefore = sseFixture.count();
  const connection = await h.services.connections.create(account.ownerId, {
    name: 'HTTP selection',
    adapter: 'pi',
    transport: 'http',
    mode: 'existing',
    url: sseFixture.url,
  });
  await expect(
    h.services.connections.discover(account.ownerId, connection.id),
  ).rejects.toMatchObject({ code: 'CONNECTION_FAILED' });
  expect(sseFixture.count()).toBe(callsBefore);
  expect(
    (await h.services.connections.list(account.ownerId)).find((row) => row.id === connection.id),
  ).toMatchObject({ status: 'error' });
});

test.each(['direct', 'pi'] as const)(
  '%s stdio runs on the platform with env/cwd and closes its subprocess',
  async (adapter) => {
    const connection = await h.services.connections.create(account.ownerId, {
      name: `${adapter} stdio`,
      adapter,
      transport: 'stdio',
      mode: 'managed',
      command: process.execPath,
      args: [
        '--import',
        pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href,
        resolve('tests/fixtureStdio.mts'),
      ],
      cwd: h.directory,
      env: { MCP_TEST_MARKER: 'stdio-environment' },
    });
    const [tool] = await h.services.connections.discover(account.ownerId, connection.id);
    const result = await h.services.invocations.call({
      ownerId: account.ownerId,
      toolId: tool!.id,
      arguments: { message: 'platform stdio' },
    });
    expect(result).toMatchObject({
      content: [{ type: 'text', text: 'platform stdio' }],
      structuredContent: { cwd: await realpath(h.directory), marker: 'stdio-environment' },
    });
    const pid = result.structuredContent!.pid as number;
    expect(Number.isInteger(pid)).toBe(true);
    await verifyExternalAgent(tool!.id);
    const authorization = await account.request(`/connections/${connection.id}/oauth/start`, {
      method: 'POST',
    });
    expect(authorization.status).toBe(400);
    expect(await authorization.json()).toMatchObject({ code: 'OAUTH_NOT_APPLICABLE' });
    await h.services.connections.stop(account.ownerId, connection.id);
    await expect.poll(() => processExists(pid)).toBe(false);
    await expect(
      h.services.invocations.call({ ownerId: account.ownerId, toolId: tool!.id, arguments: {} }),
    ).rejects.toThrow('已停止');
  },
  30_000,
);

test.each(['direct', 'pi'] as const)(
  '%s stdio children receive only the allowlisted environment plus their own env',
  async (adapter) => {
    // Simulates a platform secret in the server process env; the child must never see it.
    const previous = process.env.MCP_TEST_MARKER;
    process.env.MCP_TEST_MARKER = 'platform-process-secret';
    try {
      const connection = await h.services.connections.create(account.ownerId, {
        name: `${adapter} env allowlist`,
        adapter,
        transport: 'stdio',
        mode: 'managed',
        command: process.execPath,
        args: [
          '--import',
          pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href,
          resolve('tests/fixtureStdio.mts'),
        ],
        cwd: h.directory,
      });
      const [tool] = await h.services.connections.discover(account.ownerId, connection.id);
      const result = await h.services.invocations.call({
        ownerId: account.ownerId,
        toolId: tool!.id,
        arguments: { message: 'allowlist' },
      });
      expect(result).toMatchObject({ structuredContent: { marker: null } });
      await h.services.connections.stop(account.ownerId, connection.id);
    } finally {
      if (previous === undefined) delete process.env.MCP_TEST_MARKER;
      else process.env.MCP_TEST_MARKER = previous;
    }
  },
  30_000,
);

function processExists(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

async function verifyExternalAgent(toolId: string) {
  const profile = (await h.services.profiles.save(account.ownerId, {
    name: 'external Pi bridge',
    toolIds: [toolId],
  }))!;
  const key = await h.services.profiles.issue(account.ownerId, profile.id);
  const client = new Client({ name: 'pi-bridge-test', version: '1' });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${h.baseURL}/mcp/${profile.id}`), {
        requestInit: { headers: { Authorization: `Bearer ${key.token}` } },
      }),
    );
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(/^[A-Za-z0-9_-]{1,48}$/);
    expect(names[0]).toMatch(/__echo$/);
    expect(
      await client.callTool({ name: names[0]!, arguments: { message: 'external call' } }),
    ).toMatchObject({ content: [{ type: 'text', text: 'external call' }] });
    // The legacy `t_<sha256>` name is not listed but remains callable.
    expect(
      await client.callTool({ name: toolId, arguments: { message: 'legacy call' } }),
    ).toMatchObject({ content: [{ type: 'text', text: 'legacy call' }] });
  } finally {
    await client.close();
  }
}

test('only built-in inference tasks require model configuration', async () => {
  const pi = new PiService({
    network: h.services.network,
    logger: h.services.logger,
    db: h.db,
    config: { ...h.config, PI_ENABLED: 'true' },
    events: h.services.events,
    profiles: h.services.profiles,
    invocations: h.services.invocations,
    skills: h.services.skills,
    content: h.services.content,
    artifacts: h.services.artifacts,
  });
  await expect(
    pi.start(account.ownerId, { profileId: crypto.randomUUID(), prompt: 'run' }),
  ).rejects.toMatchObject({ code: 'MODEL_REQUIRED' });
  expect(await pi.list(account.ownerId)).toEqual([]);
});
