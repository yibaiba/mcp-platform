import { afterAll, beforeAll, expect, test } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import { connections, systemLogs, user } from '../packages/db/src/index.js';
import { ManagedStdioTransport } from '../packages/mcp/src/index.js';
import { harness } from './harness.js';

let h: Awaited<ReturnType<typeof harness>>;
beforeAll(async () => {
  h = await harness();
});
afterAll(async () => {
  await h?.close();
});
const marker = (name: string) => join(h.directory, `${name}.ran`);
// The exact payload from the review: a shell that would run `id` on the platform host.
const shellId = (name: string) => ({
  name,
  transport: 'stdio',
  mode: 'managed',
  command: '/bin/sh',
  args: ['-c', `id > '${marker(name)}'`],
});
async function logged(ownerId: string, code: string) {
  await new Promise((resolve) => setTimeout(resolve, 50));
  return h.db
    .select()
    .from(systemLogs)
    .where(and(eq(systemLogs.ownerId, ownerId), eq(systemLogs.code, code)));
}

test.each(['direct', 'pi'] as const)(
  'a member creating %s `/bin/sh -c id` is rejected with 403 and the command never runs',
  async (adapter) => {
    h.config.PLATFORM_STDIO_ENABLED = 'true';
    const member = await h.signup();
    const name = `member-${adapter}`;
    const response = await member.request('/connections', {
      method: 'POST',
      body: JSON.stringify({ ...shellId(name), adapter }),
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'HOST_STDIO_ADMIN_ONLY' });
    expect(
      await h.db.select().from(connections).where(eq(connections.ownerId, member.ownerId)),
    ).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(existsSync(marker(name))).toBe(false);
  },
);

test('updates to host stdio connections are rejected for non-admins and while the switch is off', async () => {
  h.config.PLATFORM_STDIO_ENABLED = 'true';
  const owner = await h.signup({ role: 'admin' });
  const created = await owner.request('/connections', {
    method: 'POST',
    body: JSON.stringify({ ...shellId('update'), adapter: 'direct' }),
  });
  expect(created.status).toBe(201);
  const { id } = (await created.json()) as { id: string };
  const patch = () =>
    owner.request(`/connections/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ name: 'renamed' }),
    });
  h.config.PLATFORM_STDIO_ENABLED = 'false';
  try {
    const disabled = await patch();
    expect(disabled.status).toBe(403);
    expect(await disabled.json()).toMatchObject({ code: 'HOST_STDIO_DISABLED' });
  } finally {
    h.config.PLATFORM_STDIO_ENABLED = 'true';
  }
  // A legacy row whose owner is (now) a member cannot be updated either.
  await h.db.update(user).set({ role: 'member' }).where(eq(user.id, owner.ownerId));
  const member = await patch();
  expect(member.status).toBe(403);
  expect(await member.json()).toMatchObject({ code: 'HOST_STDIO_ADMIN_ONLY' });
  expect(existsSync(marker('update'))).toBe(false);
});

test('admins are rejected too while PLATFORM_STDIO_ENABLED is off', async () => {
  h.config.PLATFORM_STDIO_ENABLED = 'false';
  try {
    const admin = await h.signup({ role: 'admin' });
    const response = await admin.request('/connections', {
      method: 'POST',
      body: JSON.stringify({ ...shellId('admin-off'), adapter: 'direct' }),
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'HOST_STDIO_DISABLED' });
    const me = (await (await admin.request('/me')).json()) as Record<string, unknown>;
    expect(me).toMatchObject({ role: 'admin', hostStdioEnabled: false, hostStdio: false });
    // Device stdio runs on the user's own machine and is unaffected by the switch.
    const pairing = await h.services.devices.createPairing(admin.ownerId, 'own laptop');
    const device = await h.services.devices.pair(pairing.code);
    const deviceConnection = await admin.request('/connections', {
      method: 'POST',
      body: JSON.stringify({ ...shellId('device'), adapter: 'device', deviceId: device.deviceId }),
    });
    expect(deviceConnection.status).toBe(201);
  } finally {
    h.config.PLATFORM_STDIO_ENABLED = 'true';
  }
  expect(existsSync(marker('admin-off'))).toBe(false);
});

test('/me reports the effective host stdio permission per role', async () => {
  h.config.PLATFORM_STDIO_ENABLED = 'true';
  const admin = await h.signup({ role: 'admin' });
  const member = await h.signup();
  expect(await (await admin.request('/me')).json()).toMatchObject({
    hostStdioEnabled: true,
    hostStdio: true,
    platformOrigin: new URL(h.config.PUBLIC_URL).origin,
  });
  expect(await (await member.request('/me')).json()).toMatchObject({
    hostStdioEnabled: true,
    hostStdio: false,
  });
});

test('existing host stdio rows are blocked at startup and connect time without spawning', async () => {
  h.config.PLATFORM_STDIO_ENABLED = 'true';
  const admin = await h.signup({ role: 'admin' });
  const created = await admin.request('/connections', {
    method: 'POST',
    body: JSON.stringify({ ...shellId('existing'), adapter: 'direct' }),
  });
  expect(created.status).toBe(201);
  const { id } = (await created.json()) as { id: string };
  expect(existsSync(marker('existing'))).toBe(false);

  h.config.PLATFORM_STDIO_ENABLED = 'false';
  try {
    expect(await h.services.connections.enforceHostStdio()).toBeGreaterThanOrEqual(1);
    const [row] = await h.db.select().from(connections).where(eq(connections.id, id));
    expect(row).toMatchObject({
      status: 'error',
      error: expect.stringContaining('PLATFORM_STDIO_ENABLED'),
    });
    expect(await logged(admin.ownerId, 'HOST_STDIO_DISABLED_BLOCKED')).not.toHaveLength(0);
    await expect(h.services.connections.discover(admin.ownerId, id)).rejects.toMatchObject({
      code: 'HOST_STDIO_DISABLED',
      status: 403,
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(existsSync(marker('existing'))).toBe(false);
  } finally {
    h.config.PLATFORM_STDIO_ENABLED = 'true';
  }

  // A demoted owner keeps the row but can no longer start it.
  await h.db.update(user).set({ role: 'member' }).where(eq(user.id, admin.ownerId));
  await expect(h.services.connections.discover(admin.ownerId, id)).rejects.toThrow(/只有管理员/);
  expect(await logged(admin.ownerId, 'HOST_STDIO_ADMIN_ONLY_BLOCKED')).not.toHaveLength(0);
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(existsSync(marker('existing'))).toBe(false);
});

test('host stdio children get an allowlisted environment plus the connection env only', async () => {
  const output = join(h.directory, 'child-env.json');
  const previous = process.env.PLATFORM_FAKE_SECRET;
  process.env.PLATFORM_FAKE_SECRET = 'must-not-leak';
  const transport = new ManagedStdioTransport({
    command: process.execPath,
    args: [
      '-e',
      `require('node:fs').writeFileSync(${JSON.stringify(output)}, JSON.stringify(process.env))`,
    ],
    env: { CONNECTION_TOKEN: 'configured' },
  });
  try {
    await transport.start();
    await expect.poll(() => existsSync(output)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const env = JSON.parse(await readFile(output, 'utf8')) as Record<string, string>;
    expect(env.CONNECTION_TOKEN).toBe('configured');
    expect(env.PATH).toBe(process.env.PATH);
    expect(env.PLATFORM_FAKE_SECRET).toBeUndefined();
    for (const key of [
      'DATABASE_URL',
      'BETTER_AUTH_SECRET',
      'ENCRYPTION_KEY',
      'DEVICE_AUTH_ENCRYPTION_KEY',
    ])
      expect(env[key]).toBeUndefined();
    const allowed = new Set([
      'PATH',
      'HOME',
      'USER',
      'SHELL',
      'TERM',
      'LOGNAME',
      'LANG',
      'LANGUAGE',
      'LC_ALL',
      'LC_CTYPE',
      'TZ',
      'TMPDIR',
      'UV_CACHE_DIR',
      'UV_TOOL_DIR',
      'UV_TOOL_BIN_DIR',
      'UV_PYTHON',
      'UV_PYTHON_DOWNLOADS',
      'CONNECTION_TOKEN',
    ]);
    // Node itself may add a few runtime keys; everything else must come from the allowlist.
    const extra = Object.keys(env).filter(
      (key) => !allowed.has(key) && !/^(NODE_|__CF|_)/.test(key),
    );
    expect(extra).toEqual([]);
  } finally {
    await transport.close().catch(() => undefined);
    if (previous === undefined) delete process.env.PLATFORM_FAKE_SECRET;
    else process.env.PLATFORM_FAKE_SECRET = previous;
  }
});
