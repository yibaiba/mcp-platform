import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import type { harness } from './harness.js';
export async function fixtureConnector(h: Awaited<ReturnType<typeof harness>>, ownerId: string) {
  const pairing = await h.services.devices.createPairing(ownerId, 'Capability connector');
  const device = await h.services.devices.pair(pairing.code);
  const path = join(h.directory, `${device.deviceId}.json`);
  await writeFile(path, JSON.stringify({ server: h.baseURL, ...device }), { mode: 0o600 });
  let child: ReturnType<typeof spawn>;
  async function start() {
    child = spawn(resolve('connector/bin/connector'), ['run', '--config', path], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    child.stderr!.on('data', (data: Buffer) => process.stderr.write(data));
    const deadline = Date.now() + 5000;
    while (!h.services.broker.hasCapability(device.deviceId, 'sessions')) {
      if (child.exitCode !== null || Date.now() > deadline) {
        child.kill('SIGINT');
        throw new Error('Connector did not declare session capability');
      }
      await pause(20);
    }
  }
  async function close() {
    if (child.exitCode !== null) return;
    const done = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    child.kill('SIGINT');
    await done;
  }
  await start();
  return {
    deviceId: device.deviceId,
    close,
    restart: async () => {
      await close();
      await start();
    },
  };
}
