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
  init:
    image: \${PLATFORM_TEST_IMAGE}
  migrate:
    image: \${PLATFORM_TEST_IMAGE}
  server:
    image: \${PLATFORM_TEST_IMAGE}
    ports: !override
      - '127.0.0.1:54330:4300'
`,
);
function composeFor(target) {
  return async function compose(args, timeout = 120_000) {
    const result = await execute(
      'docker',
      [
        'compose',
        '--env-file',
        '/dev/null',
        '-p',
        target.project,
        '-f',
        'docker-compose.yml',
        '-f',
        target.override,
        ...args,
      ],
      { cwd, env: target.env, timeout, maxBuffer: 4 * 1024 * 1024 },
    );
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    return result.stdout;
  };
}
const compose = composeFor({ project, override, env: environment });
async function request(url, options) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(5000) });
}
async function waitForHealth(base = origin) {
  const deadline = Date.now() + 90_000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await request(`${base}/health`);
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
  const signup = async (email, name) => {
    const response = await request(`${origin}/api/v1/auth/sign-up/email`, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, email, password: randomBytes(24).toString('hex') }),
    });
    assert.equal(response.status, 200, `Signup failed: ${response.status}`);
    const value = response.headers
      .getSetCookie()
      .map((entry) => entry.split(';')[0])
      .join('; ');
    assert.ok(value);
    return value;
  };
  // Fresh volume: the first account becomes administrator automatically.
  const cookie = await signup(`${project}@example.test`, 'Disposable Compose acceptance');
  const connections = await request(`${origin}/api/v1/connections`, {
    headers: { Cookie: cookie },
  });
  assert.equal(connections.status, 200);
  assert.deepEqual(await connections.json(), []);
  const me = async (session) =>
    (await request(`${origin}/api/v1/me`, { headers: { Cookie: session } })).json();
  assert.deepEqual(
    [(await me(cookie)).role, (await me(cookie)).hostStdio],
    ['admin', true],
    'The first account of an empty deployment is an admin and gets platform-host stdio',
  );
  // Every later account is a member until promoted with `pnpm user:role`.
  const memberEmail = `${project}-member@example.test`;
  const member = await signup(memberEmail, 'Disposable Compose member');
  assert.deepEqual(
    [(await me(member)).role, (await me(member)).hostStdio],
    ['member', false],
    'A second account is a member without platform-host stdio',
  );
  await compose(['exec', '-T', 'server', 'pnpm', 'user:role', memberEmail, 'admin']);
  assert.equal((await me(member)).hostStdio, true, 'pnpm user:role promotes an existing account');
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
/**
 * Zero configuration: no `.env`, no secrets, no PUBLIC_URL, ALLOW_REGISTRATION left at its
 * default (false). One `up -d` must start everything, the first sign-up must be accepted and
 * become admin, the second refused, generated secrets must be 0600 files owned by the app
 * user, and a full `down` + `up -d` (volumes kept) must keep the same keys (session survives).
 */
async function verifyZeroConfiguration() {
  const zeroOrigin = 'http://localhost:4300';
  const zeroOverride = resolve(directory, 'zero.yaml');
  await writeFile(
    zeroOverride,
    `services:
  init:
    image: \${PLATFORM_TEST_IMAGE}
  migrate:
    image: \${PLATFORM_TEST_IMAGE}
  server:
    image: \${PLATFORM_TEST_IMAGE}
    ports: !override
      - '127.0.0.1:4300:4300'
`,
  );
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) =>
        !/^(POSTGRES_PASSWORD|DATABASE_URL|BETTER_AUTH_SECRET|ENCRYPTION_KEY|DEVICE_AUTH_ENCRYPTION_KEY|PI_MCP_ADAPTER_OAUTH_FILE_KEY|PUBLIC_URL|WEB_ORIGIN|ALLOW_REGISTRATION|PLATFORM_VERSION)$/.test(
          name,
        ),
    ),
  );
  const zero = composeFor({
    project: `${project}-zero`,
    override: zeroOverride,
    env: { ...env, PLATFORM_TEST_IMAGE: image },
  });
  try {
    await zero(['up', '-d'], 240_000);
    await waitForHealth(zeroOrigin);
    const options = async () => (await request(`${zeroOrigin}/api/v1/login-options`)).json();
    assert.deepEqual(
      [(await options()).registration, (await options()).firstAccount],
      [true, true],
      'An empty deployment offers the first sign-up even with registration closed',
    );
    const signup = (email) =>
      request(`${zeroOrigin}/api/v1/auth/sign-up/email`, {
        method: 'POST',
        headers: { Origin: zeroOrigin, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Zero', email, password: randomBytes(24).toString('hex') }),
      });
    const first = await signup(`${project}-zero-admin@example.test`);
    assert.equal(first.status, 200, 'First sign-up with ALLOW_REGISTRATION unset');
    const cookie = first.headers
      .getSetCookie()
      .map((entry) => entry.split(';')[0])
      .join('; ');
    const me = async () => request(`${zeroOrigin}/api/v1/me`, { headers: { Cookie: cookie } });
    assert.equal((await (await me()).json()).role, 'admin');
    assert.equal((await signup(`${project}-zero-second@example.test`)).status, 403);
    assert.deepEqual(
      [(await options()).registration, (await options()).firstAccount],
      [false, false],
    );
    const listing = await zero([
      'exec',
      '-T',
      'server',
      'sh',
      '-c',
      'stat -c "%a %U %n" /app/.data/secrets /app/.data/secrets/* /run/platform-secrets/*',
    ]);
    const modes = listing.trim().split('\n').sort();
    assert.deepEqual(modes, [
      '600 node /app/.data/secrets/BETTER_AUTH_SECRET',
      '600 node /app/.data/secrets/DEVICE_AUTH_ENCRYPTION_KEY',
      '600 node /app/.data/secrets/ENCRYPTION_KEY',
      '600 node /app/.data/secrets/PI_MCP_ADAPTER_OAUTH_FILE_KEY',
      '600 node /run/platform-secrets/POSTGRES_PASSWORD',
      '700 node /app/.data/secrets',
    ]);
    await zero(['down']);
    await zero(['up', '-d'], 240_000);
    await waitForHealth(zeroOrigin);
    assert.equal((await me()).status, 200, 'Generated keys survive down/up: the session is valid');
    console.log(
      'PASS: zero-configuration one-command start, first sign-up admin with registration closed, persisted 0600 secrets',
    );
  } catch (error) {
    await zero(['logs', '--no-color', '--tail', '80']);
    throw error;
  } finally {
    await zero(['down', '--volumes', '--remove-orphans']);
  }
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
  await verifyZeroConfiguration();
  // Explicit configuration: every secret set in the environment; one `up -d` runs the
  // migrate service, then a repeated migration must be a no-op.
  await compose(['up', '-d', '--no-build'], 240_000);
  await compose(['run', '--rm', '--no-deps', '-T', 'server', 'pnpm', 'db:migrate']);
  await waitForHealth();
  assert.equal(
    (
      await compose([
        'exec',
        '-T',
        'server',
        'sh',
        '-c',
        'ls -A /app/.data/secrets 2>/dev/null || true',
      ])
    ).trim(),
    '',
    'Explicit secrets are used as-is and never written to the data volume',
  );
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
