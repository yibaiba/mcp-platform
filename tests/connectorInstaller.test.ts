import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { connectorTargets } from '../packages/contracts/src/connectorDistribution.js';
import { harness } from './harness.js';
import { fixtureMcp } from './fixtureMcp.js';
import { DiskConnectorFiles } from '../apps/server/src/modules/devices/connectorFiles.js';
import { installerCommand } from '../apps/web/src/features/devices/installerCommand.js';

let h: Awaited<ReturnType<typeof harness>>;
let fixture: Awaited<ReturnType<typeof fixtureMcp>>;
let directory: string;
const processes: ChildProcess[] = [];
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  process.kill(-child.pid!, 'SIGINT');
  await exited;
}
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'connector-installer-'));
  const native = connectorTargets.find(
    (target) =>
      target.os === process.platform &&
      target.arch === (process.arch === 'x64' ? 'amd64' : process.arch),
  )!;
  await copyFile('connector/bin/connector', join(directory, native.filename));
  const checksum = createHash('sha256')
    .update(await readFile(join(directory, native.filename)))
    .digest('hex');
  await writeFile(join(directory, 'SHA256SUMS'), `${checksum}  ${native.filename}\n`);
  h = await harness({
    connectorFiles: new DiskConnectorFiles({
      downloads: directory,
      installers: resolve('connector/install'),
    }),
  });
  fixture = await fixtureMcp();
});
afterAll(async () => {
  await Promise.all(processes.map(stop));
  await h?.close();
  await fixture?.close();
  await rm(directory, { recursive: true, force: true });
});

test('copied install command downloads a real connector, pairs, invokes MCP and reconnects without another code', async () => {
  const account = await h.signup();
  const pairing = await h.services.devices.createPairing(account.ownerId, 'downloaded-device');
  const installDir = join(directory, 'installed connector');
  const start = (code = '') => {
    const child = spawn('sh', ['-c', installerCommand(h.baseURL, 'unix')], {
      detached: true,
      env: { ...process.env, MCP_PLATFORM_CONNECTOR_HOME: installDir },
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    processes.push(child);
    child.stdin?.end(code ? `${code}\n` : '');
    child.stderr?.on('data', (data: Buffer) => process.stderr.write(data));
    return child;
  };
  const first = start(pairing.code);
  const configPath = join(installDir, 'connector.json');
  let deviceId = '';
  await vi.waitFor(
    async () => {
      deviceId = (JSON.parse(await readFile(configPath, 'utf8')) as { deviceId: string }).deviceId;
      expect(h.services.broker.online(deviceId)).toBe(true);
    },
    { timeout: 5000 },
  );
  const connection = await h.services.connections.create(account.ownerId, {
    name: 'downloaded connector tools',
    adapter: 'device',
    deviceId,
    transport: 'http',
    mode: 'existing',
    url: fixture.url,
  });
  const [tool] = await h.services.connections.discover(account.ownerId, connection.id);
  const result = await h.services.invocations.call({
    ownerId: account.ownerId,
    toolId: tool!.id,
    arguments: { message: 'installed connector executes MCP' },
  });
  expect(result.content).toEqual([{ type: 'text', text: 'installed connector executes MCP' }]);
  const saved = await readFile(configPath, 'utf8');
  await stop(first);
  await expect.poll(() => h.services.broker.online(deviceId)).toBe(false);
  start();
  await expect.poll(() => h.services.broker.online(deviceId), { timeout: 5000 }).toBe(true);
  expect(await readFile(configPath, 'utf8')).toBe(saved);
  expect(
    (await h.services.devices.list(account.ownerId)).filter(
      (device) => device.name === 'downloaded-device',
    ),
  ).toHaveLength(1);
});
