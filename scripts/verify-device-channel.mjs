import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { connectorTargets } from '../packages/contracts/src/connectorDistribution.ts';

const channelTimeoutMs = 20_000;
const shutdownTimeoutMs = 5_000;

export async function verifyDeviceChannel({ directory, origin, cookie, request }) {
  const arch = process.arch === 'x64' ? 'amd64' : process.arch;
  const os = process.platform === 'win32' ? 'windows' : process.platform;
  const target = connectorTargets.find((item) => item.os === os && item.arch === arch);
  assert.ok(target, `No connector build for ${process.platform}/${process.arch}`);
  const download = await request(`${origin}/api/v1/connector/downloads/${target.filename}`);
  assert.equal(download.status, 200);
  const binary = join(directory, target.filename);
  await writeFile(binary, Buffer.from(await download.arrayBuffer()), { mode: 0o700 });
  const headers = { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' };
  const pairing = await request(`${origin}/api/v1/devices/pairings`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ name: 'Compose channel acceptance' }),
  });
  assert.equal(pairing.status, 201);
  const pair = await request(`${origin}/api/v1/devices/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(await pairing.json()),
  });
  assert.equal(pair.status, 201);
  const device = await pair.json();
  const config = join(directory, 'connector.json');
  await writeFile(config, JSON.stringify({ server: origin, ...device }), { mode: 0o600 });
  const child = spawn(binary, ['run', '--config', config], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });
  const exited = new Promise((resolve, reject) => {
    child.once('exit', resolve);
    child.once('error', reject);
  });
  try {
    const listed = async () => {
      const response = await request(`${origin}/api/v1/devices`, { headers });
      assert.equal(response.status, 200);
      return (await response.json()).find((row) => row.id === device.deviceId);
    };
    await Promise.race([
      waitForDevice(listed, (row) => row?.online),
      exited.then(() => {
        throw new Error('Connector exited before its WebSocket became online');
      }),
    ]);
    const revoked = await request(`${origin}/api/v1/devices/${device.deviceId}`, {
      method: 'DELETE',
      headers,
    });
    assert.equal(revoked.status, 200);
    await waitForDevice(listed, (row) => row?.revoked && !row.online);
    console.log(
      'PASS: downloaded Go connector connects over the same-port WebSocket and revocation disconnects it',
    );
  } catch (error) {
    process.stderr.write(stderr.replaceAll(device.token, '[redacted]'));
    throw error;
  } finally {
    child.kill('SIGINT');
    const timer = setTimeout(() => child.kill('SIGKILL'), shutdownTimeoutMs);
    try {
      await exited;
    } finally {
      clearTimeout(timer);
    }
  }
}

async function waitForDevice(listed, predicate) {
  const deadline = Date.now() + channelTimeoutMs;
  while (Date.now() < deadline) {
    if (predicate(await listed())) return;
    await delay(100);
  }
  throw new Error('Device channel did not reach the expected state before the deadline');
}
