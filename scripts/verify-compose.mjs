import { verifyRestRestart } from './verify-rest-restart.mjs';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { connectorTargets } from '../packages/contracts/src/connectorDistribution.ts';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { setTimeout } from 'node:timers/promises';
import { verifyImageSource } from './verify-image-source.mjs';
import { verifyDeviceChannel } from './verify-device-channel.mjs';

const execute = promisify(execFile);
const cwd = fileURLToPath(new URL('../', import.meta.url));
await mkdir(resolve(cwd, '.data'), { recursive: true });
const directory = await mkdtemp(resolve(cwd, '.data/compose-acceptance-'));
const project = `platform-acceptance-${Date.now()}`;
const origin = 'http://localhost:54330';
const image = process.env.PLATFORM_TEST_IMAGE ?? 'mcp-platform:local';
const databasePassword = randomBytes(24).toString('hex');
const environment = {
  ...process.env,
  PLATFORM_TEST_IMAGE: image,
  PLATFORM_VERSION: 'acceptance',
  PUBLIC_URL: origin,
  WEB_ORIGIN: origin,
  DATABASE_URL: `postgresql://platform:${databasePassword}@db:5432/platform`,
  POSTGRES_PASSWORD: databasePassword,
  BETTER_AUTH_SECRET: randomBytes(32).toString('hex'),
  ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  DEVICE_AUTH_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  PI_MCP_ADAPTER_OAUTH_FILE_KEY: randomBytes(32).toString('hex'),
  ALLOW_REGISTRATION: 'true',
  PI_ENABLED: 'false',
  PLATFORM_STDIO_ENABLED: 'true',
  PI_MODEL_PROVIDER: '',
  PI_MODEL_ID: '',
};
const override = resolve(directory, 'compose.yaml');
await writeFile(
  override,
  `services:
  server:
    image: \${PLATFORM_TEST_IMAGE}
    ports: !override
      - '127.0.0.1:54330:4300'
`,
);
async function compose(args, timeout = 120_000) {
  const result = await execute(
    'docker',
    [
      'compose',
      '--env-file',
      '/dev/null',
      '-p',
      project,
      '-f',
      'docker-compose.yml',
      '-f',
      override,
      ...args,
    ],
    { cwd, env: environment, timeout, maxBuffer: 4 * 1024 * 1024 },
  );
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  return result.stdout;
}
async function request(url, options) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(5000) });
}
async function waitForHealth() {
  const deadline = Date.now() + 60_000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await request(`${origin}/health`);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { status: 'ok', piEnabled: false });
      return;
    } catch (error) {
      lastError = error;
      await setTimeout(500);
    }
  }
  throw new Error('Compose health check did not become ready', { cause: lastError });
}
async function verifyManagement() {
  const page = await request(origin);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /<div id="app">/);
  const asset = html.match(/src="([^" ]+\.js)"/);
  assert.ok(asset, 'Production page must reference a built JS asset');
  const script = await request(new URL(asset[1], origin));
  assert.equal(script.status, 200);
  assert.match(script.headers.get('content-type'), /javascript/);
  const navigation = await request(`${origin}/connections`);
  assert.equal(navigation.status, 200);
  assert.match(await navigation.text(), /<div id="app">/);
  assert.equal((await request(`${origin}/assets/missing.js`)).status, 404);
  assert.equal((await request(`${origin}/api/v1/connections`)).status, 401);
  const signup = await request(`${origin}/api/v1/auth/sign-up/email`, {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Disposable Compose acceptance',
      email: `${project}@example.test`,
      password: randomBytes(24).toString('hex'),
    }),
  });
  assert.equal(signup.status, 200, `Signup failed: ${signup.status}`);
  const cookie = signup.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
  assert.ok(cookie);
  const connections = await request(`${origin}/api/v1/connections`, {
    headers: { Cookie: cookie },
  });
  assert.equal(connections.status, 200);
  assert.deepEqual(await connections.json(), []);
  const me = async () =>
    (await request(`${origin}/api/v1/me`, { headers: { Cookie: cookie } })).json();
  assert.equal((await me()).hostStdio, false, 'A new member must not get platform-host stdio');
  await compose(['exec', '-T', 'server', 'pnpm', 'user:role', `${project}@example.test`, 'admin']);
  assert.equal((await me()).hostStdio, true, 'An admin gets platform-host stdio when enabled');
  console.log('PASS: single-port web, database health, authentication and management API');
  return cookie;
}
async function verifySandbox() {
  const response = await request(`${origin}/_apps/sandbox?parent=${encodeURIComponent(origin)}`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-security-policy'), /script-src 'sha256-/);
  assert.equal((await request(`${origin}/_apps/api/v1/connections`)).status, 404);
  const html = '<!doctype html><h1>Disposable isolated frame</h1>';
  const creation = await request(`${origin}/_apps/frames`, {
    method: 'POST',
    headers: { Origin: 'null', 'Content-Type': 'application/json' },
    body: JSON.stringify({ html }),
  });
  assert.equal(creation.status, 200);
  const { path } = await creation.json();
  const frame = await request(new URL(path, origin));
  assert.equal(frame.status, 200);
  assert.equal(await frame.text(), html);
  assert.match(frame.headers.get('content-security-policy'), /sandbox allow-scripts allow-forms/);
  assert.equal((await request(new URL(path, origin))).status, 410);
  console.log('PASS: same-port Apps proxy, single-use document and sandbox CSP HTTP contract');
}
async function verifyConnectorDownloads() {
  const response = await request(`${origin}/api/v1/connector/downloads/SHA256SUMS`);
  assert.equal(response.status, 200);
  const manifest = new Map(
    (await response.text())
      .trim()
      .split('\n')
      .map((line) => {
        const [digest, name] = line.split('  ');
        return [name, digest];
      }),
  );
  for (const target of connectorTargets) {
    const download = await request(`${origin}/api/v1/connector/downloads/${target.filename}`);
    assert.equal(download.status, 200, target.filename);
    const checksum = createHash('sha256')
      .update(new Uint8Array(await download.arrayBuffer()))
      .digest('hex');
    assert.equal(checksum, manifest.get(target.filename), target.filename);
  }
  for (const installer of ['install.sh', 'install.ps1']) {
    const script = await request(`${origin}/api/v1/connector/${installer}`);
    assert.equal(script.status, 200);
    assert.match(script.headers.get('content-type'), /text\/plain/);
  }
  console.log('PASS: public installers and all six connector downloads match packaged SHA-256');
}
try {
  await verifyImageSource(image, cwd);
  const offline = await execute(
    'docker',
    ['run', '--rm', '--network', 'none', image, 'pnpm', '--version'],
    { cwd, timeout: 60_000 },
  );
  assert.equal(offline.stdout.trim(), '10.12.4');
  console.log('PASS: runtime user can run the packaged pnpm with networking disabled');
  await compose(['up', '-d', '--wait', 'db']);
  await compose(['run', '--rm', '--no-deps', '-T', 'server', 'pnpm', 'db:migrate']);
  await compose(['run', '--rm', '--no-deps', '-T', 'server', 'pnpm', 'db:migrate']);
  await compose(['up', '-d', '--no-build', 'server']);
  await waitForHealth();
  const cookie = await verifyManagement();
  await verifyConnectorDownloads();
  await verifyDeviceChannel({ directory, origin, cookie, request });
  await verifyRestRestart({
    origin,
    headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' },
    compose,
    waitForHealth,
  });
  await verifySandbox();
  await compose(['exec', '-T', 'server', 'node', 'scripts/check.mjs', '60', 'pnpm', 'test:pi']);
  console.log('PASS: fresh Compose migrations, repeat migration and actual no-model Pi bridge');
} catch (error) {
  await compose(['logs', '--no-color', '--tail', '50', 'server']);
  throw error;
} finally {
  await compose(['down', '--volumes', '--remove-orphans']);
  await rm(directory, { recursive: true });
}
