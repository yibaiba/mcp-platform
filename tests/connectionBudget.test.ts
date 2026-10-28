import { afterAll, beforeAll, expect, test } from 'vitest';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { harness } from './harness.js';
import { fixtureMcp } from './fixtureMcp.js';
import { fixtureConnector } from './fixtureConnector.js';

let h: Awaited<ReturnType<typeof harness>>;
let account: Awaited<ReturnType<Awaited<ReturnType<typeof harness>>['signup']>>;
beforeAll(async () => {
  h = await harness();
  account = await h.signup();
});
afterAll(async () => {
  await h?.close();
});

test.each(['direct', 'pi', 'device'] as const)(
  '%s applies progress renewal and the total deadline to real stdio calls',
  async (adapter) => {
    const device = adapter === 'device' ? await fixtureConnector(h, account.ownerId) : undefined;
    const connection = await h.services.connections.create(account.ownerId, {
      name: `budget ${adapter}`,
      adapter,
      deviceId: device?.deviceId,
      transport: 'stdio',
      mode: 'managed',
      command: process.execPath,
      args: [
        '--import',
        pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href,
        resolve('tests/fixtureStdio.mts'),
      ],
      requestOptions: { timeoutMs: 150, resetTimeoutOnProgress: true, maxTotalTimeoutMs: 600 },
    });
    try {
      const [tool] = await h.services.connections.discover(account.ownerId, connection.id);
      const input = { ownerId: account.ownerId, toolId: tool!.id };
      const result = await h.services.invocations.call({
        ...input,
        arguments: { message: 'renewed', delay: 300, progress: 30 },
      });
      expect(result.content).toEqual([{ type: 'text', text: 'renewed' }]);
      await expect(
        h.services.invocations.call({ ...input, arguments: { delay: 900, progress: 30 } }),
      ).rejects.toMatchObject({ code: 'RESULT_UNKNOWN' });
    } finally {
      await h.services.connections.stop(account.ownerId, connection.id);
      await device?.close();
    }
  },
);

test('first discovery failure recovers a real catalog automatically without executing tools', async () => {
  let failures = 1;
  const fixture = await fixtureMcp({
    beforeList: async () => {
      if (failures-- > 0) throw new Error('temporarily unavailable');
    },
  });
  const connection = await h.services.connections.create(account.ownerId, {
    name: 'recover first discovery',
    adapter: 'direct',
    transport: 'http',
    mode: 'existing',
    url: fixture.url,
    health: { recover: true, initialIntervalMs: 30, maxIntervalMs: 60 },
  });
  try {
    await expect(h.services.connections.discover(account.ownerId, connection.id)).rejects.toThrow();
    await expect
      .poll(async () => (await h.services.connections.owned(account.ownerId, connection.id)).status)
      .toBe('connected');
    expect(
      (await h.services.connections.snapshot(account.ownerId, connection.id))?.tools.map(
        (tool) => tool.name,
      ),
    ).toEqual(['echo']);
    expect(fixture.count()).toBe(0);
    await h.services.connections.stop(account.ownerId, connection.id);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect((await h.services.connections.owned(account.ownerId, connection.id)).status).toBe(
      'stopped',
    );
  } finally {
    await h.services.connections.stop(account.ownerId, connection.id);
    await fixture.close();
  }
});
test.each(['update', 'delete'] as const)(
  '%s cancels pending recovery without restoring old configuration',
  async (operation) => {
    const fixture = await fixtureMcp();
    const connection = await h.services.connections.create(account.ownerId, {
      name: 'pending replacement',
      adapter: 'direct',
      transport: 'http',
      mode: 'existing',
      url: 'http://127.0.0.1:1/mcp',
      health: { recover: true, initialIntervalMs: 100, maxIntervalMs: 100 },
    });
    try {
      await expect(
        h.services.connections.discover(account.ownerId, connection.id),
      ).rejects.toThrow();
      if (operation === 'delete') {
        const response = await account.request(`/connections/${connection.id}`, {
          method: 'DELETE',
        });
        expect(response.status).toBe(200);
      } else {
        await h.services.connections.update(account.ownerId, connection.id, { url: fixture.url });
        await h.services.connections.discover(account.ownerId, connection.id);
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
      const row = (await h.services.connections.list(account.ownerId)).find(
        (row) => row.id === connection.id,
      );
      if (operation === 'delete') expect(row).toBeUndefined();
      else {
        expect(row?.status).toBe('connected');
        expect(row?.error).toBeNull();
      }
      expect(fixture.count()).toBe(0);
    } finally {
      if (operation === 'update') await h.services.connections.stop(account.ownerId, connection.id);
      await fixture.close();
    }
  },
);
