import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { devices, pairings, connections } from '../packages/db/src/index.js';
import { deviceAuthInput, deviceAuthResponse } from '../packages/contracts/src/index.js';
import { envSchema } from '../apps/server/src/config.js';
import { Vault } from '../apps/server/src/shared/crypto.js';
import { verifyDeviceMac } from '../apps/server/src/modules/devices/deviceAuthentication.js';
import { harness } from './harness.js';
import { authPeer, authResponse, WebSocket } from './fixtureDeviceAuth.js';
let h: Awaited<ReturnType<typeof harness>>;
let owner: Awaited<ReturnType<typeof h.signup>>;
let stranger: Awaited<ReturnType<typeof h.signup>>;
const peers: Awaited<ReturnType<typeof authPeer>>[] = [];
beforeAll(async () => {
  h = await harness();
  owner = await h.signup();
  stranger = await h.signup();
});
afterAll(async () => {
  for (const peer of peers) peer.ws.terminate();
  await h?.close();
});
async function paired() {
  return h.services.devices.pair(
    (await h.services.devices.createPairing(owner.ownerId, 'HMAC device')).code,
  );
}
async function peer() {
  const result = await authPeer(h.baseURL);
  peers.push(result);
  return result;
}
async function rejected(socket: Awaited<ReturnType<typeof authPeer>>, response: unknown) {
  socket.send(response);
  expect(await socket.next()).toMatchObject({ type: 'auth.failure' });
  expect(await socket.closed).toBe(1008);
}
test('Node and Go share canonical JSON, origin and MAC vectors', async () => {
  const vectors = JSON.parse(
    await readFile(
      new URL('../packages/contracts/testdata/device-auth-vectors.json', import.meta.url),
      'utf8',
    ),
  ) as {
    platformOrigin: string;
    deviceId: string;
    credentialVersion: number;
    deviceSecret: string;
    nonce: string;
    expiresAt: string;
    input: string;
    mac: string;
  }[];
  for (const vector of vectors) {
    const challenge = {
      type: 'auth.challenge' as const,
      v: 1 as const,
      nonce: vector.nonce,
      expiresAt: vector.expiresAt,
    };
    expect(deviceAuthInput({ ...vector, challenge })).toBe(vector.input);
    expect(authResponse(vector, challenge, vector.platformOrigin).mac).toBe(vector.mac);
    expect(
      verifyDeviceMac({
        secret: vector.deviceSecret,
        platformOrigin: vector.platformOrigin,
        challenge,
        response: deviceAuthResponse.parse(authResponse(vector, challenge, vector.platformOrigin)),
      }),
    ).toBe(true);
  }
});
test('authentication key is required, canonical, independent and AAD-bound', () => {
  for (const value of [
    undefined,
    '',
    randomBytes(31).toString('base64'),
    randomBytes(32).toString('base64url'),
  ])
    expect(envSchema.safeParse({ ...h.config, DEVICE_AUTH_ENCRYPTION_KEY: value }).success).toBe(
      false,
    );
  const vault = new Vault(h.config.DEVICE_AUTH_ENCRYPTION_KEY);
  const sealed = vault.seal('private', '["device-auth","owner","device",1]');
  for (const scope of [
    '["device-auth","other","device",1]',
    '["device-auth","owner","other",1]',
    '["device-auth","owner","device",2]',
  ])
    expect(() => vault.open(sealed, scope)).toThrow();
  expect(() =>
    new Vault(h.config.ENCRYPTION_KEY).open(sealed, '["device-auth","owner","device",1]'),
  ).toThrow();
});
test('no business registration before authentication; failures cannot evict a live device', async () => {
  const device = await paired();
  const good = await peer();
  expect(h.services.broker.online(device.deviceId)).toBe(false);
  await expect(
    h.services.broker.request(device.deviceId, { method: 'check', params: {} }),
  ).rejects.toThrow('离线');
  good.send(authResponse(device, good.challenge, h.baseURL));
  expect(await good.next()).toEqual({ type: 'auth.success', v: 1 });
  expect(h.services.broker.online(device.deviceId)).toBe(true);
  const another = await paired();
  for (const patch of [
    { deviceSecret: randomBytes(32).toString('base64url') },
    { deviceId: another.deviceId },
    { credentialVersion: device.credentialVersion + 1 },
  ]) {
    const bad = await peer();
    await rejected(bad, authResponse({ ...device, ...patch }, bad.challenge, h.baseURL));
    expect(h.services.broker.online(device.deviceId)).toBe(true);
  }
});
test('responses are connection-bound and consumed once, including failed attempts', async () => {
  const device = await paired();
  const first = await peer();
  const second = await peer();
  expect(first.challenge.nonce).not.toBe(second.challenge.nonce);
  const response = authResponse(device, first.challenge, h.baseURL);
  await rejected(second, response);
  first.send(response);
  first.send(response);
  expect(await first.next()).toMatchObject({ type: 'auth.failure' });
  await first.closed;
  expect(h.services.broker.online(device.deviceId)).toBe(false);
});
test('expired challenges, wrong origin, invalid frames and pre-auth hello fail without dispatch', async () => {
  const device = await paired();
  const expired = await peer();
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    vi.setSystemTime(Date.parse(expired.challenge.expiresAt));
    await rejected(expired, authResponse(device, expired.challenge, h.baseURL));
  } finally {
    vi.useRealTimers();
  }
  const wrongOrigin = await peer();
  await rejected(wrongOrigin, authResponse(device, wrongOrigin.challenge, 'https://other.example'));
  for (const raw of ['{invalid json', ' '.repeat(4097), JSON.stringify({ type: 'hello', v: 1 })]) {
    const socket = await peer();
    socket.ws.send(raw);
    expect(await socket.next()).toMatchObject({ type: 'auth.failure' });
    await socket.closed;
  }
  expect(h.services.broker.online(device.deviceId)).toBe(false);
});
test('re-pairing is owned, single-use, expiring, preserves identity and bindings, and revocation is final', async () => {
  const device = await paired();
  const connection = await h.services.connections.create(owner.ownerId, {
    name: 'preserved MCP',
    adapter: 'device',
    deviceId: device.deviceId,
    mode: 'existing',
    transport: 'http',
    url: 'https://example.test/mcp',
  });
  const live = await peer();
  live.send(authResponse(device, live.challenge, h.baseURL));
  await live.next();
  expect(
    (await stranger.request(`/devices/${device.deviceId}/re-pairings`, { method: 'POST' })).status,
  ).toBe(404);
  expect(
    (await h.app.request(`/api/v1/devices/${device.deviceId}/re-pairings`, { method: 'POST' }))
      .status,
  ).toBe(401);
  expect(
    (
      await owner.request(`/devices/${device.deviceId}/re-pairings`, {
        method: 'POST',
        headers: { Origin: 'https://other.test' },
      })
    ).status,
  ).toBe(403);
  const old = await h.services.devices.createRePairing(owner.ownerId, device.deviceId);
  await live.closed;
  expect(h.services.broker.online(device.deviceId)).toBe(false);
  expect(
    (await h.services.devices.list(owner.ownerId)).find((d) => d.id === device.deviceId)
      ?.pairingRequired,
  ).toBe(true);
  const next = await h.services.devices.createRePairing(owner.ownerId, device.deviceId);
  await expect(h.services.devices.pair(old.code, device.deviceId)).rejects.toThrow('配对码');
  await expect(h.services.devices.pair(next.code)).rejects.toThrow('匹配');
  await expect(h.services.devices.pair(next.code, (await paired()).deviceId)).rejects.toThrow(
    '匹配',
  );
  const replaced = await h.services.devices.pair(next.code, device.deviceId);
  expect(replaced.deviceId).toBe(device.deviceId);
  expect(replaced.credentialVersion).toBe(3);
  expect(replaced.deviceSecret).not.toBe(device.deviceSecret);
  await expect(h.services.devices.pair(next.code, device.deviceId)).rejects.toThrow('配对码');
  expect(
    (await h.db.select().from(connections).where(eq(connections.id, connection.id)))[0]?.deviceId,
  ).toBe(device.deviceId);
  const oldKey = await peer();
  await rejected(oldKey, authResponse(device, oldKey.challenge, h.baseURL));
  const newKey = await peer();
  newKey.send(authResponse(replaced, newKey.challenge, h.baseURL));
  expect(await newKey.next()).toMatchObject({ type: 'auth.success' });
  const expires = await h.services.devices.createRePairing(owner.ownerId, device.deviceId);
  await h.db
    .update(pairings)
    .set({ expiresAt: new Date(0) })
    .where(eq(pairings.deviceId, device.deviceId));
  await expect(h.services.devices.pair(expires.code, device.deviceId)).rejects.toThrow('过期');
  const final = await h.services.devices.createRePairing(owner.ownerId, device.deviceId);
  await h.services.devices.revoke(owner.ownerId, device.deviceId);
  await expect(h.services.devices.pair(final.code, device.deviceId)).rejects.toThrow();
  await expect(h.services.devices.createRePairing(owner.ownerId, device.deviceId)).rejects.toThrow(
    '撤销',
  );
});
test('authentication completion is serialized with re-pair and revoke', async () => {
  const device = await paired();
  const socket = await peer();
  const input = {
    challenge: socket.challenge,
    response: deviceAuthResponse.parse(authResponse(device, socket.challenge, h.baseURL)),
    register: vi.fn(),
  };
  await Promise.all([
    h.services.devices.authenticate(input),
    h.services.devices.createRePairing(owner.ownerId, device.deviceId),
  ]);
  expect(input.register).toHaveBeenCalledOnce();
  input.register.mockClear();
  await expect(h.services.devices.authenticate(input)).rejects.toThrow('认证失败');
  expect(input.register).not.toHaveBeenCalled();
  const code = await h.services.devices.createRePairing(owner.ownerId, device.deviceId);
  const next = await h.services.devices.pair(code.code, device.deviceId);
  const response = deviceAuthResponse.parse(authResponse(next, socket.challenge, h.baseURL));
  await Promise.all([
    h.services.devices.revoke(owner.ownerId, device.deviceId),
    expect(h.services.devices.authenticate({ ...input, response })).rejects.toThrow('认证失败'),
  ]);
  expect(input.register).not.toHaveBeenCalled();
});
test('pair response is no-store and list explicitly excludes credentials', async () => {
  expect(await (await owner.request('/me')).json()).toMatchObject({ platformOrigin: h.baseURL });
  const code = await h.services.devices.createPairing(owner.ownerId, 'no secret export');
  const response = await h.app.request('/api/v1/devices/pair', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: code.code }),
  });
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  const device = (await response.json()) as { deviceId: string; deviceSecret: string };
  const row = (await h.db.select().from(devices).where(eq(devices.id, device.deviceId)))[0]!;
  expect(row.secretEncrypted).not.toContain(device.deviceSecret);
  const list = JSON.stringify(await h.services.devices.list(owner.ownerId));
  for (const sensitive of [
    device.deviceSecret,
    row.secretEncrypted!,
    'secretEncrypted',
    'tokenHash',
    'deviceSecret',
    'mac',
  ])
    expect(list).not.toContain(sensitive);
});

test('legacy Bearer and browser Origin upgrades are rejected before a challenge', async () => {
  for (const headers of [{ Authorization: 'Bearer legacy-device-token' }, { Origin: h.baseURL }]) {
    const ws = new WebSocket(h.baseURL.replace(/^http/, 'ws') + '/api/v1/devices/channel', {
      headers,
    });
    ws.on('error', () => undefined);
    const status = await new Promise<number | undefined>((resolve) =>
      ws.once('unexpected-response', (_request, response) => {
        response.resume();
        resolve(response.statusCode);
        ws.terminate();
      }),
    );
    expect(status).toBe(401);
  }
});

test('an unanswered challenge closes at the 30-second deadline', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    const socket = await peer();
    vi.advanceTimersByTime(30_000);
    expect(await socket.next()).toMatchObject({ type: 'auth.failure' });
    expect(await socket.closed).toBe(1008);
  } finally {
    vi.useRealTimers();
  }
});

test('legacy connector errors at the deadline remain outcome unknown before the local timer runs', async () => {
  const device = await paired();
  const live = await peer();
  live.send(authResponse(device, live.challenge, h.baseURL));
  await live.next();
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    for (const expired of [false, true]) {
      const call = h.services.broker.request(device.deviceId, {
        method: 'call',
        params: {},
        executionTimeoutMs: 60_000,
      });
      const assertion = expect(call).rejects.toMatchObject({
        code: expired ? 'RESULT_UNKNOWN' : 'EXECUTION_FAILED',
      });
      const request = (await live.next()) as { id: string; deadline: string };
      if (expired) vi.setSystemTime(Date.parse(request.deadline));
      live.send({
        v: 1,
        type: 'result',
        id: request.id,
        error: { code: 'EXECUTION_FAILED', message: 'context deadline exceeded' },
      });
      await assertion;
    }
  } finally {
    vi.useRealTimers();
  }
});
