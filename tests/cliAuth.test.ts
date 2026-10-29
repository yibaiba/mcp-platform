import { randomBytes, createHash } from 'node:crypto';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { beforeAll, afterAll, expect, test } from 'vitest';
import { eq } from 'drizzle-orm';
import { cliGrants, user } from '../packages/db/src/index.js';
import { ConfigStore } from '../packages/cli/src/configStore.js';
import { HttpClient, tokenResponse } from '../packages/cli/src/httpClient.js';
import { login } from '../packages/cli/src/login.js';
import { harness } from './harness.js';
import { fixtureMcp } from './fixtureMcp.js';
let h: Awaited<ReturnType<typeof harness>>, upstream: Awaited<ReturnType<typeof fixtureMcp>>;
const directory = await mkdtemp(join(tmpdir(), 'platform-cli-'));
beforeAll(async () => {
  h = await harness();
  upstream = await fixtureMcp();
});
afterAll(async () => {
  await h?.close();
  await upstream?.close();
  await rm(directory, { recursive: true, force: true });
});
const specification = (scope = 'management:read management:write') => {
  const verifier = randomBytes(32).toString('base64url');
  return {
    verifier,
    input: {
      redirect_uri: 'http://127.0.0.1:54123/callback',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
      state: randomBytes(32).toString('base64url'),
      scope,
    },
  };
};
async function consent(account: Awaited<ReturnType<typeof h.signup>>, input: unknown) {
  return fetch(`${h.baseURL}/api/v1/cli/consent`, {
    method: 'POST',
    headers: {
      Cookie: account.cookie,
      Origin: h.config.WEB_ORIGIN,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(input),
  });
}
async function authorize(account: Awaited<ReturnType<typeof h.signup>>, scope?: string) {
  const { verifier, input } = specification(scope);
  const approved = await consent(account, input);
  expect(approved.status).toBe(200);
  const redirect = new URL((await approved.json()).redirect);
  const body = {
    grant_type: 'authorization_code',
    code: redirect.searchParams.get('code'),
    code_verifier: verifier,
    redirect_uri: input.redirect_uri,
  };
  return {
    body,
    token: tokenResponse.parse(
      await (
        await fetch(`${h.baseURL}/api/v1/cli/token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
      ).json(),
    ),
  };
}
const bearer = (token: string) => ({
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
});
test('HTTP PKCE code is single use, refresh rotates, revocation and account disabling invalidate management access', async () => {
  const account = await h.signup();
  const { body, token } = await authorize(account);
  expect(
    (
      await fetch(`${h.baseURL}/api/v1/cli/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
    ).status,
  ).toBe(401);
  const refresh = () =>
    fetch(`${h.baseURL}/api/v1/cli/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: token.refresh_token }),
    });
  const next = tokenResponse.parse(await (await refresh()).json());
  expect((await refresh()).status).toBe(401);
  expect(
    (await fetch(`${h.baseURL}/api/v1/me`, { headers: bearer(token.access_token) })).status,
  ).toBe(401);
  expect(
    (await fetch(`${h.baseURL}/api/v1/me`, { headers: bearer(next.access_token) })).status,
  ).toBe(200);
  const [stored] = await h.db.select().from(cliGrants).where(eq(cliGrants.id, token.grant_id));
  expect(JSON.stringify(stored)).not.toContain(next.access_token);
  expect(JSON.stringify(stored)).not.toContain(next.refresh_token);
  await h.db
    .update(cliGrants)
    .set({ refreshExpiresAt: new Date(0) })
    .where(eq(cliGrants.id, token.grant_id));
  expect(
    (await fetch(`${h.baseURL}/api/v1/me`, { headers: bearer(next.access_token) })).status,
  ).toBe(401);
  await h.db
    .update(cliGrants)
    .set({ refreshExpiresAt: stored!.refreshExpiresAt })
    .where(eq(cliGrants.id, token.grant_id));
  await h.db.update(user).set({ enabled: false }).where(eq(user.id, account.ownerId));
  expect(
    (await fetch(`${h.baseURL}/api/v1/me`, { headers: bearer(next.access_token) })).status,
  ).toBe(401);
  await h.db.update(user).set({ enabled: true }).where(eq(user.id, account.ownerId));
  expect(
    (
      await fetch(`${h.baseURL}/api/v1/cli/logout`, {
        method: 'POST',
        headers: bearer(next.access_token),
      })
    ).status,
  ).toBe(200);
  expect(
    (await fetch(`${h.baseURL}/api/v1/me`, { headers: bearer(next.access_token) })).status,
  ).toBe(401);
});
test('readonly scope, browser Origin, role and credential boundaries remain independent', async () => {
  const account = await h.signup(),
    { token } = await authorize(account, 'management:read');
  expect(
    (
      await fetch(`${h.baseURL}/api/v1/profiles`, {
        method: 'POST',
        headers: bearer(token.access_token),
        body: JSON.stringify({ name: 'forbidden' }),
      })
    ).status,
  ).toBe(403);
  expect(
    (await fetch(`${h.baseURL}/api/v1/admin/users`, { headers: bearer(token.access_token) }))
      .status,
  ).toBe(403);
  expect(
    (
      await fetch(`${h.baseURL}/api/v1/profiles`, {
        method: 'POST',
        headers: { Cookie: account.cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'csrf' }),
      })
    ).status,
  ).toBe(403);
  const profile = (await h.services.profiles.save(account.ownerId, { name: 'agent' }))!;
  const key = await h.services.profiles.issue(account.ownerId, profile.id);
  expect((await fetch(`${h.baseURL}/api/v1/me`, { headers: bearer(key.token) })).status).toBe(401);
  expect(
    (
      await fetch(`${h.baseURL}/mcp/${profile.id}/rest/tools`, {
        headers: bearer(token.access_token),
      })
    ).status,
  ).toBe(401);
  expect(
    (
      await fetch(`${h.baseURL}/api/v1/tools/x/call`, {
        method: 'POST',
        headers: bearer(token.access_token),
        body: '{}',
      })
    ).status,
  ).toBe(403);
  const spec = specification();
  expect(
    (await consent(account, { ...spec.input, redirect_uri: 'http://example.com/callback' })).status,
  ).toBe(400);
  const redirect = new URL((await (await consent(account, spec.input)).json()).redirect);
  expect(
    (
      await fetch(`${h.baseURL}/api/v1/cli/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          code: redirect.searchParams.get('code'),
          code_verifier: randomBytes(32).toString('base64url'),
          redirect_uri: spec.input.redirect_uri,
        }),
      })
    ).status,
  ).toBe(401);
});
test('CLI real loopback callback rejects wrong state, stores private credentials, supports JSON environments and calls a real MCP process once', async () => {
  const account = await h.signup(),
    store = new ConfigStore(directory);
  await store.write({
    current: 'test',
    environments: { test: { url: h.baseURL }, second: { url: 'http://127.0.0.1:1' } },
  });
  const client = new HttpClient({ fetch, store, env: {} });
  await login({
    client,
    readOnly: false,
    signal: new AbortController().signal,
    diagnostic: () => {},
    open: async (raw) => {
      const auth = new URL(raw);
      expect((await fetch(raw, { redirect: 'manual' })).status).toBe(302);
      const redirect = new URL(
        (await (await consent(account, Object.fromEntries(auth.searchParams))).json()).redirect,
      );
      const wrong = new URL(redirect);
      wrong.searchParams.set('state', 'wrong');
      expect((await fetch(wrong)).status).toBe(400);
      expect((await fetch(redirect)).status).toBe(200);
    },
  });
  expect((await stat(join(directory, 'config.json'))).mode & 0o777).toBe(0o600);
  const command = async (args: string[], env: NodeJS.ProcessEnv = {}) =>
    promisify(execFile)(
      process.execPath,
      ['--import', 'tsx', 'packages/cli/src/main.ts', ...args, '--json'],
      {
        env: {
          ...process.env,
          MCP_PLATFORM_CONFIG_DIR: directory,
          MCP_PLATFORM_ACCESS_TOKEN: '',
          ...env,
        },
        timeout: 15000,
      },
    );
  expect(JSON.parse((await command(['whoami'])).stdout).userId).toBe(account.ownerId);
  expect(JSON.parse((await command(['env', 'list'])).stdout).environments.test).not.toHaveProperty(
    'credentials',
  );
  const connection = await h.services.connections.create(account.ownerId, {
    name: 'cli',
    adapter: 'direct',
    mode: 'existing',
    transport: 'http',
    url: upstream.url,
  });
  const [tool] = await h.services.connections.discover(account.ownerId, connection.id);
  const profile = (await h.services.profiles.save(account.ownerId, {
    name: 'cli',
    toolIds: [tool!.id],
  }))!;
  const issued = JSON.parse((await command(['keys', 'create', profile.id])).stdout);
  const args = [
    'tools',
    'call',
    tool!.id,
    '--profile',
    profile.id,
    '--data',
    JSON.stringify({ message: 'cli-once' }),
    '--idempotency-key',
    'cli-once',
  ];
  const before = upstream.count();
  const result = await command(args, { MCP_PLATFORM_AGENT_TOKEN: issued.token });
  expect(JSON.stringify(JSON.parse(result.stdout))).toContain('cli-once');
  await command(args, { MCP_PLATFORM_AGENT_TOKEN: issued.token });
  expect(upstream.count()).toBe(before + 1);
  await expect(command(['unknown'])).rejects.toMatchObject({ code: 2 });
  await expect(command(['whoami'], { MCP_PLATFORM_ACCESS_TOKEN: 'invalid' })).rejects.toMatchObject(
    { code: 3 },
  );
  await expect(command(['whoami', '--env', 'second'])).rejects.toMatchObject({ code: 3 });
  await expect(
    command(['whoami', '--env', 'second'], { MCP_PLATFORM_ACCESS_TOKEN: 'network-test' }),
  ).rejects.toMatchObject({ code: 4 });
  await command(['logout']);
  expect((await store.read()).environments.test?.credentials).toBeUndefined();
});
test('CLI returns exit 5 with the original JSON for an upstream business error', async () => {
  const failed = await fixtureMcp({ toolError: true });
  try {
    const { ownerId } = await h.signup();
    const connection = await h.services.connections.create(ownerId, {
      name: 'tool-error',
      adapter: 'direct',
      mode: 'existing',
      transport: 'http',
      url: failed.url,
    });
    const [tool] = await h.services.connections.discover(ownerId, connection.id);
    const profile = (await h.services.profiles.save(ownerId, {
      name: 'tool-error',
      toolIds: [tool!.id],
    }))!;
    const key = await h.services.profiles.issue(ownerId, profile.id);
    const run = promisify(execFile)(
      process.execPath,
      [
        '--import',
        'tsx',
        'packages/cli/src/main.ts',
        'tools',
        'call',
        tool!.id,
        '--profile',
        profile.id,
        '--json',
      ],
      {
        env: {
          ...process.env,
          MCP_PLATFORM_CONFIG_DIR: directory,
          MCP_PLATFORM_AGENT_TOKEN: key.token,
        },
        timeout: 15000,
      },
    );
    await expect(run).rejects.toMatchObject({
      code: 5,
      stdout: expect.stringContaining('"isError":true'),
    });
    expect(failed.count()).toBe(1);
    expect(h.services.metrics.render().join('\n')).toContain(
      'platform_calls_total{entry="rest",adapter="direct",status="tool_error"} 1',
    );
  } finally {
    await failed.close();
  }
});
