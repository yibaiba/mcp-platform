import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { harness } from './harness.js';
import { archive } from './fixtureBundle.js';
let h: Awaited<ReturnType<typeof harness>>;
let child: ChildProcess;
beforeAll(async () => {
  h = await harness();
});
afterAll(async () => {
  if (child && child.exitCode === null) {
    const exited = new Promise<void>((done) => child.once('exit', () => done()));
    child.kill('SIGINT');
    await exited;
  }
  await h?.close();
});
test('real HMAC connector installs immutable bytes, discovers MCP and denies revoked access', async () => {
  const { ownerId } = await h.signup();
  const pairing = await h.services.devices.createPairing(ownerId, 'MCPB fixture device');
  const device = await h.services.devices.pair(pairing.code);
  const directory = join(h.directory, 'bundle-device');
  await mkdir(directory);
  const config = join(directory, 'connector.json');
  await writeFile(config, JSON.stringify({ server: h.baseURL, ...device }), { mode: 0o600 });
  child = spawn(
    resolve('connector/bin/connector'),
    ['run', '--config', config, '--data-dir', join(directory, 'data')],
    { env: { ...process.env, HOME: directory }, stdio: ['ignore', 'ignore', 'pipe'] },
  );
  child.stderr?.on('data', (data) => process.stderr.write(data));
  await vi.waitFor(() => expect(h.services.broker.online(device.deviceId)).toBe(true), {
    timeout: 5000,
  });
  const pkg = await h.services.bundles.upload(
    ownerId,
    new Blob([new Uint8Array(archive())]).stream(),
  );
  const destination = {
    adapter: 'device',
    deviceId: device.deviceId,
    values: { key: 'device-fixture-private' },
  };
  const preview = await h.services.bundles.preview(ownerId, pkg.id, destination);
  expect(JSON.stringify(preview)).not.toContain('device-fixture-private');
  expect(await h.services.connections.list(ownerId)).toHaveLength(0);
  const operation = {
    ...destination,
    operationId: randomUUID(),
    previewDigest: preview.previewDigest,
  };
  const installed = await h.services.bundles.install(ownerId, pkg.id, operation);
  expect(installed.state).toBe('succeeded');
  expect((await h.services.profiles.catalog(ownerId))[0]!.name).toBe('echo');
  expect((await h.services.bundles.install(ownerId, pkg.id, operation)).connectionId).toBe(
    installed.connectionId,
  );
  await expect(
    h.services.broker.request(device.deviceId, {
      method: 'mcpb.install',
      params: {
        sha256: pkg.sha256,
        operationId: randomUUID(),
        archive: Buffer.from(archive()).toString('base64'),
        config: { command: 'forbidden' },
      },
    }),
  ).rejects.toThrow();
  await h.services.devices.revoke(ownerId, device.deviceId);
  await expect(h.services.bundles.preview(ownerId, pkg.id, destination)).rejects.toThrow();
}, 20000);

test('legacy connector without MCPB capability refuses preview without creating a connection', async () => {
  if (child && child.exitCode === null) {
    const exited = new Promise<void>((done) => child.once('exit', () => done()));
    child.kill('SIGINT');
    await exited;
  }
  const { ownerId } = await h.signup();
  const pairing = await h.services.devices.createPairing(ownerId, 'legacy bundle device');
  const device = await h.services.devices.pair(pairing.code);
  const config = join(h.directory, 'legacy-bundle-device.json');
  await writeFile(config, JSON.stringify({ server: h.baseURL, ...device }), { mode: 0o600 });
  child = spawn(resolve('connector/bin/connector'), ['run', '--config', config], {
    env: { ...process.env, HOME: h.directory },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr?.on('data', (data) => process.stderr.write(data));
  await vi.waitFor(() => expect(h.services.broker.online(device.deviceId)).toBe(true), {
    timeout: 5000,
  });
  const pkg = await h.services.bundles.upload(
    ownerId,
    new Blob([new Uint8Array(archive())]).stream(),
  );
  await expect(
    h.services.bundles.preview(ownerId, pkg.id, {
      adapter: 'device',
      deviceId: device.deviceId,
      values: { key: 'private' },
    }),
  ).rejects.toThrow();
  expect(await h.services.connections.list(ownerId)).toHaveLength(0);
});
