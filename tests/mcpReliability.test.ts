import { afterAll, beforeAll, expect, test } from 'vitest';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import type { ImportPreview } from '../packages/contracts/src/index.js';
import { harness } from './harness.js';
import { fixtureMcp } from './fixtureMcp.js';

let h: Awaited<ReturnType<typeof harness>>;
let account: Awaited<ReturnType<typeof h.signup>>;
beforeAll(async () => {
  h = await harness();
  account = await h.signup();
});
afterAll(async () => {
  await h?.close();
});

test('import previews unmapped fields and missing devices without hiding valid declarations', async () => {
  const source = {
    local: {
      type: 'stdio',
      command: 'node',
      cwd: '/workspace',
      options: { timeout: 90_000 },
      perSessionClient: true,
      oauth: { clientSecret: 'not-for-migration' },
    },
    remote: {
      type: 'streamable-http',
      url: 'https://example.test/mcp',
      headers: { 'X-Test': 'configured' },
    },
  };
  const response = await account.request('/import/preview', {
    method: 'POST',
    body: JSON.stringify({ mcpServers: source }),
  });
  expect(response.status).toBe(200);
  const preview = (await response.json()) as ImportPreview[];
  expect(preview[0]).toMatchObject({
    needsDevice: true,
    config: { cwd: '/workspace', transport: 'stdio' },
  });
  expect(preview[0]!.errors.length).toBeGreaterThan(0);
  expect(preview[0]!.warnings.map((warning) => warning.field)).toEqual([
    'options',
    'perSessionClient',
    'oauth',
  ]);
  expect(JSON.stringify(preview)).not.toContain('not-for-migration');
  expect(preview[1]).toMatchObject({ config: { transport: 'http' }, errors: [] });
  const pair = await h.services.devices.createPairing(account.ownerId, 'import target');
  const device = await h.services.devices.pair(pair.code);
  const input = { mcpServers: source, deviceId: device.deviceId };
  const applied = await account.request('/import/apply', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  expect(applied.status).toBe(201);
  const ids = (await applied.json()) as { id: string }[];
  expect((await h.services.connections.context(account.ownerId, ids[0]!.id)).config).toMatchObject({
    cwd: '/workspace',
    deviceId: device.deviceId,
  });
  await h.services.devices.revoke(account.ownerId, device.deviceId);
  await expect(h.services.connections.discover(account.ownerId, ids[0]!.id)).rejects.toMatchObject({
    code: 'NOT_FOUND',
  });
});

test('unsupported import transports cannot silently become HTTP or create partial imports', async () => {
  const input = {
    mcpServers: {
      valid: { url: 'https://example.test/mcp' },
      unsupported: { type: 'openapi', url: 'https://example.test/openapi.json' },
    },
  };
  const before = await h.services.connections.list(account.ownerId);
  const preview = await account.request('/import/preview', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  expect(preview.status).toBe(200);
  const rows = (await preview.json()) as ImportPreview[];
  expect(rows[1]!.errors.join(';')).toContain('openapi');
  expect(rows[1]!.config).not.toHaveProperty('transport', 'http');
  const applied = await account.request('/import/apply', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  expect(applied.status).toBe(400);
  expect(await h.services.connections.list(account.ownerId)).toHaveLength(before.length);
});

test('stopping a connection during discovery cannot be undone by a late upstream result', async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const fixture = await fixtureMcp({
    beforeList: async () => {
      entered.resolve();
      await release.promise;
    },
  });
  try {
    const connection = await h.services.connections.create(account.ownerId, {
      name: 'stop race',
      adapter: 'direct',
      transport: 'http',
      mode: 'existing',
      url: fixture.url,
    });
    const pending = h.services.connections
      .discover(account.ownerId, connection.id)
      .catch((error: unknown) => error);
    await entered.promise;
    await h.services.connections.stop(account.ownerId, connection.id);
    release.resolve();
    expect(await pending).toMatchObject({ code: 'CONNECTION_SUPERSEDED' });
    expect(await h.services.connections.owned(account.ownerId, connection.id)).toMatchObject({
      status: 'stopped',
      error: null,
    });
    expect(
      (await h.services.profiles.catalog(account.ownerId)).some(
        (tool) => tool.connectionId === connection.id,
      ),
    ).toBe(false);
  } finally {
    release.resolve();
    await fixture.close();
  }
});

test('cancelling one discovery preserves concurrent discovery on the same connection', async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const fixture = await fixtureMcp({
    beforeList: async () => {
      entered.resolve();
      await release.promise;
    },
  });
  let settled: Promise<unknown> | undefined;
  try {
    const connection = await h.services.connections.create(account.ownerId, {
      name: 'isolated cancellation',
      adapter: 'direct',
      transport: 'http',
      mode: 'existing',
      url: fixture.url,
    });
    const abort = new AbortController();
    const first = h.services.connections
      .discover(account.ownerId, connection.id, abort.signal)
      .catch((error: unknown) => error);
    await entered.promise;
    const second = h.services.connections.discover(account.ownerId, connection.id);
    settled = Promise.allSettled([first, second]);
    const reason = new Error('cancel first request');
    abort.abort(reason);
    expect(await first).toMatchObject({ message: expect.stringContaining(reason.message) });
    release.resolve();
    expect((await second).map((tool) => tool.name)).toEqual(['echo']);
    expect(await h.services.connections.owned(account.ownerId, connection.id)).toMatchObject({
      status: 'connected',
      error: null,
    });
    await h.services.connections.stop(account.ownerId, connection.id);
  } finally {
    release.resolve();
    await settled;
    await fixture.close();
  }
});

test('stdio startup errors include redacted subprocess stderr', async () => {
  const connection = await h.services.connections.create(account.ownerId, {
    name: 'failed subprocess',
    adapter: 'direct',
    transport: 'stdio',
    mode: 'managed',
    command: process.execPath,
    args: [
      '-e',
      'process.stderr.write("required resource missing: " + process.env.TEST_SECRET + "\\n"); process.exit(23)',
    ],
    env: { TEST_SECRET: 'private-startup-secret' },
  });
  const response = await account.request(`/connections/${connection.id}/discover`, {
    method: 'POST',
  });
  expect(response.status).toBe(502);
  const diagnostic = JSON.stringify(await response.json());
  expect(diagnostic).toContain('required resource missing: [redacted]');
  expect(diagnostic).not.toContain('private-startup-secret');
  expect(await h.services.connections.owned(account.ownerId, connection.id)).toMatchObject({
    status: 'error',
    error: expect.stringContaining('required resource missing'),
  });
});

test('a new explicit call reconnects a terminated stdio service without replaying an earlier call', async () => {
  const connection = await h.services.connections.create(account.ownerId, {
    name: 'stdio reconnect',
    adapter: 'direct',
    transport: 'stdio',
    mode: 'managed',
    command: process.execPath,
    args: [
      '--import',
      pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href,
      resolve('tests/fixtureStdio.mts'),
    ],
  });
  const [tool] = await h.services.connections.discover(account.ownerId, connection.id);
  const input = {
    ownerId: account.ownerId,
    toolId: tool!.id,
    arguments: { message: 'explicit call' },
  };
  const first = await h.services.invocations.call(input);
  const oldPid = first.structuredContent!.pid as number;
  process.kill(oldPid, 'SIGKILL');
  await expect
    .poll(
      async () =>
        (await h.services.connections.list(account.ownerId)).find((row) => row.id === connection.id)
          ?.status,
    )
    .toBe('disconnected');
  const second = await h.services.invocations.call(input);
  expect(second.structuredContent!.pid).not.toBe(oldPid);
  expect(second.content).toEqual([{ type: 'text', text: 'explicit call' }]);
  await h.services.connections.stop(account.ownerId, connection.id);
});
