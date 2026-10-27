import { afterAll, beforeAll, expect, test } from 'vitest';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFile, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { connectorTargets } from '../packages/contracts/src/connectorDistribution.js';
import { DiskConnectorFiles } from '../apps/server/src/modules/devices/connectorFiles.js';
import { connectorDistributionRoutes } from '../apps/server/src/modules/devices/distributionRoutes.js';
import { AppError } from '../apps/server/src/shared/errors.js';
import { installerCommand } from '../apps/web/src/features/devices/installerCommand.js';

const exec = promisify(execFile);
const native = connectorTargets.find(
  (target) =>
    target.os === process.platform &&
    target.arch === (process.arch === 'x64' ? 'amd64' : process.arch),
)!;
let directory: string;
let baseURL: string;
let server: ReturnType<typeof serve>;
let app: Hono;
let checksum: string;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'connector-distribution-'));
  await copyFile('connector/bin/connector', join(directory, native.filename));
  checksum = createHash('sha256')
    .update(await readFile(join(directory, native.filename)))
    .digest('hex');
  await writeFile(join(directory, 'SHA256SUMS'), `${checksum}  ${native.filename}\n`);
  app = new Hono();
  app.onError((error, c) =>
    error instanceof AppError
      ? c.json({ code: error.code, error: error.message }, error.status as 400)
      : c.json({ error: error.message }, 500),
  );
  app.route(
    '/api/v1/connector',
    connectorDistributionRoutes(
      new DiskConnectorFiles({ downloads: directory, installers: resolve('connector/install') }),
    ),
  );
  server = serve({ fetch: app.fetch, port: 0 });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No distribution address');
  baseURL = `http://localhost:${address.port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(directory, { recursive: true, force: true });
});

test('anonymous downloads contain the actual native executable and matching SHA-256', async () => {
  const response = await fetch(`${baseURL}/api/v1/connector/downloads/${native.filename}`);
  expect(response.status).toBe(200);
  expect(response.headers.get('content-disposition')).toContain(native.filename);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(
    createHash('sha256')
      .update(new Uint8Array(await response.arrayBuffer()))
      .digest('hex'),
  ).toBe(checksum);
  const manifest = await app.request('/api/v1/connector/downloads/SHA256SUMS');
  expect(await manifest.text()).toBe(`${checksum}  ${native.filename}\n`);
});

test.each([
  'connector.json',
  'connector-windows-amd64',
  'connector-darwin-amd64.exe',
  '..%2f..%2f.env',
  'install.sh',
])('rejects arbitrary download filename %s', async (name) => {
  const response = await app.request(`/api/v1/connector/downloads/${name}`);
  expect(response.status).toBe(404);
});

test('missing artifacts fail with an actionable 503', async () => {
  const missing = connectorTargets.find((target) => target.filename !== native.filename)!;
  const response = await app.request(`/api/v1/connector/downloads/${missing.filename}`);
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({
    code: 'CONNECTOR_NOT_BUILT',
    error: expect.stringContaining('pnpm connector:build'),
  });
});

test.each(['sh', 'ps1'])('serves installer source as plain text (%s)', async (extension) => {
  const response = await app.request(`/api/v1/connector/install.${extension}`);
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('text/plain');
  expect(await response.text()).toBe(
    await readFile(`connector/install/install.${extension}`, 'utf8'),
  );
});

test('shell installer downloads and verifies the executable while preserving existing configuration', async () => {
  const installDir = join(directory, 'installation with spaces');
  await mkdir(installDir);
  const config = '{"kept":"existing device configuration"}';
  await writeFile(join(installDir, 'connector.json'), config);
  const result = await exec(
    'sh',
    ['connector/install/install.sh', '--server', baseURL, '--install-only'],
    {
      env: { ...process.env, MCP_PLATFORM_CONNECTOR_HOME: installDir },
      timeout: 15_000,
    },
  );
  expect(result.stdout).toContain('Connector installed:');
  expect(
    createHash('sha256')
      .update(await readFile(join(installDir, 'connector')))
      .digest('hex'),
  ).toBe(checksum);
  expect((await stat(join(installDir, 'connector'))).mode & 0o777).toBe(0o700);
  expect(await readFile(join(installDir, 'connector.json'), 'utf8')).toBe(config);
});

test('checksum mismatch leaves the previous executable intact and exits with failure', async () => {
  const installDir = join(directory, 'mismatch');
  await mkdir(installDir);
  await writeFile(join(installDir, 'connector'), 'previous executable');
  await writeFile(join(directory, 'SHA256SUMS'), `${'0'.repeat(64)}  ${native.filename}\n`);
  try {
    await expect(
      exec('sh', ['connector/install/install.sh', '--server', baseURL, '--install-only'], {
        env: { ...process.env, MCP_PLATFORM_CONNECTOR_HOME: installDir },
        timeout: 15_000,
      }),
    ).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('checksum mismatch') });
    expect(await readFile(join(installDir, 'connector'), 'utf8')).toBe('previous executable');
  } finally {
    await writeFile(join(directory, 'SHA256SUMS'), `${checksum}  ${native.filename}\n`);
  }
});

test('bootstrap command fails if its script cannot be downloaded', async () => {
  const noInstaller = serve({
    fetch: () => new Response('missing installer', { status: 404 }),
    port: 0,
  });
  await new Promise<void>((resolve) => noInstaller.once('listening', resolve));
  const address = noInstaller.address();
  if (!address || typeof address === 'string') throw new Error('No error server address');
  try {
    await expect(
      exec('sh', ['-c', installerCommand(`http://localhost:${address.port}`, 'unix')], {
        timeout: 5000,
      }),
    ).rejects.toMatchObject({ code: 22 });
  } finally {
    await new Promise<void>((resolve) => noInstaller.close(() => resolve()));
  }
});
