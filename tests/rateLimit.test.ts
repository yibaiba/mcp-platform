import { afterAll, beforeAll, expect, test } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { harness } from './harness.js';
import { fixtureMcp } from './fixtureMcp.js';
import { RateLimiter } from '../apps/server/src/shared/rateLimit.js';

// Requests reach the test server from 127.0.0.1, a trusted proxy hop by default, so each test
// picks its own client address with X-Forwarded-For and the per-address buckets stay apart.
let now = 7_000 * 60_000;
let h: Awaited<ReturnType<typeof harness>>;
let strict: Awaited<ReturnType<typeof harness>>;
let defaults: Awaited<ReturnType<typeof harness>>;
let upstream: Awaited<ReturnType<typeof fixtureMcp>>;
const small = {
  RATE_LIMIT_ENABLED: 'true',
  RATE_LIMIT_MCP_PER_CREDENTIAL: '8',
  RATE_LIMIT_MCP_PER_USER: '12',
  RATE_LIMIT_MCP_PER_IP: '20',
  RATE_LIMIT_AUTH_PER_IP: '5',
  RATE_LIMIT_LOGIN_PER_IP: '3',
};
beforeAll(async () => {
  upstream = await fixtureMcp();
  h = await harness({ env: small, rateLimiter: new RateLimiter(() => now) });
  strict = await harness({ env: { ...small, TRUSTED_PROXIES: 'none' } });
  defaults = await harness({ env: { RATE_LIMIT_ENABLED: 'true' } });
});
afterAll(async () => {
  await h?.close();
  await strict?.close();
  await defaults?.close();
  await upstream?.close();
});

async function agent(target: typeof h, keys = 1) {
  const account = await target.signup();
  const connection = await target.services.connections.create(account.ownerId, {
    name: 'echo',
    adapter: 'direct',
    transport: 'http',
    mode: 'existing',
    url: upstream.url,
  });
  const tools = await target.services.connections.discover(account.ownerId, connection.id);
  const profile = (await target.services.profiles.save(account.ownerId, {
    name: 'rate',
    toolIds: tools.map((tool) => tool.id),
  }))!;
  const tokens: string[] = [];
  for (let i = 0; i < keys; i++)
    tokens.push((await target.services.profiles.issue(account.ownerId, profile.id)).token);
  return { profile, tokens, url: `${target.baseURL}/mcp/${profile.id}` };
}
const rpc = (url: string, token: string, ip: string) =>
  fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'X-Forwarded-For': ip,
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
  });
async function burst(count: number, send: () => Promise<Response>) {
  const statuses: number[] = [];
  for (let i = 0; i < count; i++) {
    const response = await send();
    statuses.push(response.status);
    await response.body?.cancel();
  }
  return statuses;
}

test('MCP: per-credential then per-user limits, with Retry-After and a JSON-RPC error body', async () => {
  const { tokens, url } = await agent(h, 2);
  const first = await burst(8, () => rpc(url, tokens[0]!, '198.51.100.1'));
  expect(first.every((status) => status !== 429)).toBe(true);
  const limited = await rpc(url, tokens[0]!, '198.51.100.1');
  expect(limited.status).toBe(429);
  const retry = Number(limited.headers.get('retry-after'));
  expect(retry).toBeGreaterThanOrEqual(1);
  expect(retry).toBeLessThanOrEqual(120);
  expect(await limited.json()).toEqual({
    jsonrpc: '2.0',
    id: null,
    error: {
      code: -32000,
      message: `请求太频繁，请 ${retry} 秒后再试`,
      data: { code: 'RATE_LIMITED', scope: 'credential', retryAfter: retry, limit: 8 },
    },
  });
  // A second key of the same Agent has its own credential bucket, but shares the user's.
  const second = await burst(4, () => rpc(url, tokens[1]!, '198.51.100.1'));
  expect(second.every((status) => status !== 429)).toBe(true);
  const user = await rpc(url, tokens[1]!, '198.51.100.1');
  expect(user.status).toBe(429);
  expect((await user.json()).error.data.scope).toBe('user');
  // REST endpoints under /mcp share the same buckets and answer in REST form.
  const rest = await fetch(`${url}/openapi.json`, {
    headers: { Authorization: `Bearer ${tokens[1]}`, 'X-Forwarded-For': '198.51.100.1' },
  });
  expect(rest.status).toBe(429);
  expect(await rest.json()).toMatchObject({ code: 'RATE_LIMITED', scope: 'user' });
  // Recovery after the advertised wait.
  now += 120_000;
  expect((await rpc(url, tokens[0]!, '198.51.100.1')).status).not.toBe(429);
});

test('MCP: SDK client gets 429, recovers after Retry-After; per-address limit runs before auth', async () => {
  const { tokens, url } = await agent(h);
  const client = new Client({ name: 'rate-test', version: '1' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), {
      requestInit: {
        headers: { Authorization: `Bearer ${tokens[0]}`, 'X-Forwarded-For': '198.51.100.2' },
      },
    }),
  );
  let error: unknown;
  let calls = 0;
  try {
    for (; calls < 20; calls++) await client.listTools();
  } catch (caught) {
    error = caught;
  }
  expect(calls).toBeGreaterThan(3);
  expect(String(error)).toMatch(/429|请求太频繁/);
  now += 120_000;
  expect((await client.listTools()).tools.length).toBe(1);
  await client.close();

  // Unauthenticated flood from one address: 401s until the address limit, then 429.
  const bogus = await burst(20, () => rpc(url, 'not-a-key', '203.0.113.50'));
  expect(new Set(bogus)).toEqual(new Set([401]));
  const blocked = await rpc(url, 'not-a-key', '203.0.113.50');
  expect(blocked.status).toBe(429);
  expect((await blocked.json()).error.data.scope).toBe('ip');
  expect((await rpc(url, 'not-a-key', '203.0.113.51')).status).toBe(401);
});

const signIn = (target: typeof h, ip: string) =>
  fetch(`${target.baseURL}/api/v1/auth/sign-in/email`, {
    method: 'POST',
    headers: {
      Origin: 'http://localhost:4301',
      'Content-Type': 'application/json',
      'X-Forwarded-For': ip,
    },
    body: JSON.stringify({ email: 'nobody@example.test', password: 'wrong-password-123' }),
  });

test('login: Better Auth limiter is on, keyed by the resolved address, with a Chinese message', async () => {
  const tries = await burst(3, () => signIn(h, '192.0.2.10'));
  expect(new Set(tries)).toEqual(new Set([401]));
  const limited = await signIn(h, '192.0.2.10');
  expect(limited.status).toBe(429);
  const seconds = Number(limited.headers.get('retry-after'));
  expect(seconds).toBeGreaterThanOrEqual(1);
  // Better Auth's own 429 (no platform `scope`), translated: Retry-After plus a message the
  // login page shows as is.
  expect(await limited.json()).toEqual({
    code: 'RATE_LIMITED',
    message: `请求太频繁，请 ${seconds} 秒后再试`,
  });
  // Another client address is unaffected.
  expect((await signIn(h, '192.0.2.11')).status).toBe(401);
});

test('login: with TRUSTED_PROXIES=none a forged X-Forwarded-For does not get fresh buckets', async () => {
  const statuses: number[] = [];
  for (let i = 0; i < 4; i++) statuses.push((await signIn(strict, `192.0.2.${100 + i}`)).status);
  expect(statuses).toEqual([401, 401, 401, 429]);
});

test('OAuth / CLI / pairing endpoints share a per-address limit; session reads are exempt', async () => {
  const register = () =>
    fetch(`${h.baseURL}/api/v1/oauth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '192.0.2.20' },
      body: JSON.stringify({ redirect_uris: ['http://127.0.0.1:9/cb'], client_name: 'x' }),
    });
  const statuses = await burst(5, register);
  expect(statuses).not.toContain(429);
  const limited = await register();
  expect(limited.status).toBe(429);
  expect(limited.headers.get('retry-after')).toBeTruthy();
  expect(await limited.json()).toMatchObject({ code: 'RATE_LIMITED', scope: 'auth' });
  const pair = await fetch(`${h.baseURL}/api/v1/devices/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '192.0.2.20' },
    body: JSON.stringify({ code: 'nope' }),
  });
  expect(pair.status).toBe(429);
  const sessions = await burst(30, () =>
    fetch(`${h.baseURL}/api/v1/auth/get-session`, { headers: { 'X-Forwarded-For': '192.0.2.20' } }),
  );
  expect(sessions).not.toContain(429);
});

test('defaults do not get in the way of a busy client: tools/list plus 300 parallel calls', async () => {
  const { tokens, url } = await agent(defaults);
  const client = new Client({ name: 'busy', version: '1' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { Authorization: `Bearer ${tokens[0]}` } },
    }),
  );
  try {
    for (let i = 0; i < 5; i++) await client.listTools();
    const [tool] = (await client.listTools()).tools;
    const results = await Promise.all(
      Array.from({ length: 300 }, (_, i) =>
        client.callTool({ name: tool!.name, arguments: { message: `m${i}` } }),
      ),
    );
    expect(results.filter((result) => result.isError)).toEqual([]);
    expect((await client.listTools()).tools).toHaveLength(1);
  } finally {
    await client.close();
  }
  // 300 real calls through the gateway: ~7 s alone, slower while the full suite runs in parallel.
}, 60_000);
