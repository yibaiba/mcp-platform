import { authPeer, authResponse } from './fixtureDeviceAuth.js';
import { fixtureConnector } from './fixtureConnector.js';
import { beforeAll, afterAll, test, expect } from 'vitest';
import { createServer } from 'node:http';
import { eq, sql } from 'drizzle-orm';
import { user, connections, networkConfiguration } from '../packages/db/src/index.js';
import { harness } from './harness.js';
import {
  latestStable,
  newerThanConfigured,
  pythonVersions,
} from '../apps/server/src/modules/updates/packageVersions.js';
import { identifyPackage } from '../packages/network/src/sources.js';
let h: Awaited<ReturnType<typeof harness>>;
let account: Awaited<ReturnType<typeof h.signup>>;
let member: Awaited<ReturnType<typeof h.signup>>;
let origin: string;
let requests = 0;
let respond: (() => void) | undefined;
let hold = false;
let failed = false;
const metadataRequests: { url?: string; auth?: string }[] = [];
const server = createServer((req, res) => {
  metadataRequests.push({ url: req.url, auth: req.headers.authorization });
  requests++;
  const finish = () => {
    res.writeHead(failed ? 404 : 200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify(
        req.url?.startsWith('/simple/')
          ? {
              files: [
                { filename: 'fixture_pkg-1.0-py3-none-any.whl' },
                { filename: 'fixture_pkg-1.1.post1-py3-none-any.whl' },
                { filename: 'fixture_pkg-2.0rc1-py3-none-any.whl' },
                { filename: 'fixture_pkg-2.1.dev1-py3-none-any.whl' },
                { filename: 'fixture_pkg-3.0-py3-none-any.whl', yanked: true },
              ],
            }
          : { versions: { '1.0.0': {}, '1.9.0': {}, '2.0.0-rc.1': {} } },
      ),
    );
  };
  if (hold) respond = finish;
  else finish();
});
beforeAll(async () => {
  h = await harness();
  account = await h.signup();
  member = await h.signup();
  await h.db.update(user).set({ role: 'admin' }).where(eq(user.id, account.ownerId));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
});
afterAll(async () => {
  await h.db.delete(networkConfiguration);
  await h.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
async function connection(extra = {}) {
  return h.services.connections.create(account.ownerId, {
    name: 'package only',
    adapter: 'direct',
    mode: 'managed',
    transport: 'stdio',
    command: 'npx',
    args: ['--registry', origin, 'fixture-pkg@1.0.0'],
    ...extra,
  });
}
test('SemVer and PEP 440 stable versions including epochs, post/dev and prerelease filtering', () => {
  expect(latestStable('npm', ['1.9.0', '2.0.0-rc.1', '1.10.0'])).toBe('1.10.0');
  expect(latestStable('pypi', ['1.0', '1.0.post1', '2.0rc1', '2.1.dev1'])).toBe('1.0.post1');
  expect(latestStable('pypi', ['2.0rc1', '2.1.dev1'])).toBeNull();
  expect(
    latestStable('pypi', ['1.0', '1.0.post1', '1.1.dev1', '1.1rc1', '1!0.1', '1!0.1+local']),
  ).toBe('1!0.1+local');
  expect(
    newerThanConfigured(
      { ecosystem: 'pypi', name: 'x', source: origin, configured: '==1.0' },
      '1.0.post1',
    ),
  ).toBe(true);
  expect(
    newerThanConfigured(
      { ecosystem: 'npm', name: 'x', source: origin, configured: 'latest' },
      '1.0.0',
    ),
  ).toBeNull();
  expect(
    pythonVersions(
      JSON.stringify({
        files: [
          { filename: 'pkg-1.0-py3-none-any.whl' },
          { filename: 'pkg-2.0.tar.gz', yanked: true },
        ],
      }),
      'application/json',
    ),
  ).toEqual(['1.0']);
});
test('only unambiguous static package commands are recognized', () => {
  expect(
    identifyPackage({ command: 'npm', args: ['exec', '-p', '@scope/name@1.0.0', '--', 'name'] }),
  ).toMatchObject({ name: '@scope/name', configured: '1.0.0' });
  expect(
    identifyPackage({ command: 'npx', args: ['-p', 'one', '-p', 'two', '--', 'run'] }),
  ).toBeUndefined();
  expect(identifyPackage({ command: 'sh', args: ['-c', 'npx pkg'] })).toBeUndefined();
  expect(identifyPackage({ command: 'uvx', args: ['--from', 'pkg==2.0', 'run'] })).toMatchObject({
    name: 'pkg',
    configured: '==2.0',
  });
});
test('owner-only checks query real metadata without installation, running version remains unknown', async () => {
  const row = await connection();
  expect(
    (await member.request(`/connections/${row.id}/package-update`, { method: 'POST' })).status,
  ).toBe(404);
  const response = await account.request(`/connections/${row.id}/package-update`, {
    method: 'POST',
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    scheduled: false,
    runtimeVersion: null,
    stale: false,
    result: {
      state: 'checked',
      latest: '1.9.0',
      updateAvailable: true,
      package: { source: origin },
    },
  });
  const current = await h.services.connections.owned(account.ownerId, row.id);
  expect(current.status).not.toBe('connected');
  expect(
    (
      await member.request(`/connections/${row.id}/package-update`, {
        method: 'PATCH',
        body: JSON.stringify({ scheduled: true }),
      })
    ).status,
  ).toBe(404);
});
test('concurrent checks coalesce; failures keep stale historical success without switching source', async () => {
  const row = await connection();
  const before = requests;
  hold = true;
  const first = h.services.packageUpdates.check(account.ownerId, row.id);
  const second = h.services.packageUpdates.check(account.ownerId, row.id);
  await expect.poll(() => Boolean(respond)).toBe(true);
  hold = false;
  respond!();
  respond = undefined;
  await Promise.all([first, second]);
  expect(requests - before).toBe(1);
  failed = true;
  const failure = await h.services.packageUpdates.check(account.ownerId, row.id);
  failed = false;
  expect(failure).toMatchObject({
    result: {
      state: 'failed',
      error: '包源查询返回 HTTP 404',
      lastSuccess: { stale: true, latest: '1.9.0' },
    },
  });
});
test('connection changes invalidate an in-flight result and previous checks', async () => {
  const row = await connection();
  await h.services.packageUpdates.check(account.ownerId, row.id);
  hold = true;
  const check = h.services.packageUpdates.check(account.ownerId, row.id);
  const rejected = expect(check).rejects.toMatchObject({ code: 'CHECK_SUPERSEDED' });
  await expect.poll(() => Boolean(respond)).toBe(true);
  await h.db
    .update(connections)
    .set({ revision: sql`${connections.revision} + 1` })
    .where(eq(connections.id, row.id));
  hold = false;
  respond!();
  respond = undefined;
  await rejected;
  expect(await h.services.packageUpdates.status(account.ownerId, row.id)).toMatchObject({
    stale: true,
  });
});
test('admin network settings encrypt credentials, redact reads, enforce revisions and preserve/clear actions', async () => {
  expect((await member.request('/admin/network-settings')).status).toBe(403);
  const response = await account.request('/admin/network-settings', {
    method: 'PUT',
    body: JSON.stringify({
      revision: 0,
      settings: {},
      secrets: { githubApiToken: { action: 'replace', value: 'fixture-secret' } },
    }),
  });
  expect(response.status).toBe(200);
  expect(await response.text()).not.toContain('fixture-secret');
  const [saved] = await h.db.select().from(networkConfiguration);
  expect(saved!.encrypted).not.toContain('fixture-secret');
  expect(
    (
      await account.request('/admin/network-settings', {
        method: 'PUT',
        body: JSON.stringify({ revision: 0, settings: {} }),
      })
    ).status,
  ).toBe(409);
  await h.services.network.save(account.ownerId, { revision: 1, settings: {}, secrets: {} });
  expect((await h.services.network.view(account.ownerId)).secrets.githubApiToken).toBe(true);
  await h.services.network.save(account.ownerId, {
    revision: 2,
    settings: {},
    secrets: { githubApiToken: { action: 'clear' } },
  });
  expect((await h.services.network.view(account.ownerId)).secrets.githubApiToken).toBe(false);
  await h.db.delete(networkConfiguration);
});

test('real HMAC device checks metadata locally, offline and revoked devices are explicit', async () => {
  const device = await fixtureConnector(h, account.ownerId);
  try {
    const row = await connection({ adapter: 'device', deviceId: device.deviceId });
    expect(await h.services.packageUpdates.check(account.ownerId, row.id)).toMatchObject({
      result: { state: 'checked', latest: '1.9.0', runtimeVersion: null, deviceNetworkRevision: 0 },
    });
    await device.close();
    await expect.poll(() => h.services.broker.online(device.deviceId)).toBe(false);
    expect(await h.services.packageUpdates.check(account.ownerId, row.id)).toMatchObject({
      result: { state: 'failed', error: '设备离线，未执行包检查' },
    });
    await h.services.devices.revoke(account.ownerId, device.deviceId);
    expect(await h.services.packageUpdates.check(account.ownerId, row.id)).toMatchObject({
      result: { state: 'failed' },
    });
  } finally {
    await device.close();
  }
});

test('an authenticated old connector explicitly rejects package checks without dispatch', async () => {
  const device = await h.services.devices.pair(
    (await h.services.devices.createPairing(account.ownerId, 'old device')).code,
  );
  const peer = await authPeer(h.baseURL);
  try {
    peer.send(authResponse(device, peer.challenge, h.baseURL));
    expect(await peer.next()).toMatchObject({ type: 'auth.success' });
    const row = await connection({ adapter: 'device', deviceId: device.deviceId });
    expect(await h.services.packageUpdates.check(account.ownerId, row.id)).toMatchObject({
      result: { state: 'failed', error: expect.stringMatching(/升级|能力/) },
    });
  } finally {
    peer.ws.terminate();
    await peer.closed;
  }
});

test('platform and real HMAC device check the same authenticated Python source without installing', async () => {
  const device = await fixtureConnector(h, account.ownerId);
  const source = new URL('simple/', origin);
  source.username = 'fixture';
  source.password = 'password';
  const before = metadataRequests.length;
  try {
    for (const adapter of ['direct', 'device']) {
      const row = await connection({
        adapter,
        deviceId: adapter === 'device' ? device.deviceId : undefined,
        command: 'uvx',
        args: ['--index-url', source.href, 'fixture_pkg==1.0'],
      });
      const status = await h.services.packageUpdates.check(account.ownerId, row.id);
      expect(status).toMatchObject({
        result: {
          state: 'checked',
          latest: '1.1.post1',
          runtimeVersion: null,
          updateAvailable: true,
        },
      });
      expect(JSON.stringify(status)).not.toContain('password');
      expect((await h.services.connections.owned(account.ownerId, row.id)).status).not.toBe(
        'connected',
      );
    }
    expect(metadataRequests.slice(before)).toEqual([
      { url: '/simple/fixture-pkg/', auth: 'Basic Zml4dHVyZTpwYXNzd29yZA==' },
      { url: '/simple/fixture-pkg/', auth: 'Basic Zml4dHVyZTpwYXNzd29yZA==' },
    ]);
  } finally {
    await device.close();
  }
});
