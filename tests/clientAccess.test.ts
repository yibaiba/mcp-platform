import { afterAll, beforeAll, expect, test } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { clientPresets, clientPresetInfo } from '../packages/contracts/src/clientPresets.js';
import {
  clientServerName,
  exportClient,
  installLinks,
} from '../apps/server/src/modules/agent-profiles/clientExport.js';
import { harness } from './harness.js';
import { fixtureMcp } from './fixtureMcp.js';

let h: Awaited<ReturnType<typeof harness>>;
let upstream: Awaited<ReturnType<typeof fixtureMcp>>;
beforeAll(async () => {
  h = await harness();
  upstream = await fixtureMcp();
});
afterAll(async () => {
  await h?.close();
  await upstream?.close();
});
type Output = ReturnType<typeof exportClient>;
// Exactly what Cursor sends in one DCR request (forum.cursor.com/t/171867).
const cursorRedirects = [
  'cursor://anysphere.cursor-mcp/oauth/callback',
  'https://www.cursor.com/agents/mcp/oauth/callback',
  'http://localhost:8787/callback',
];

test('every preset has a readable label, and Claude Desktop is one of them', () => {
  for (const preset of clientPresets) expect(clientPresetInfo[preset].label).toBeTruthy();
  for (const preset of ['generic-mcp-servers', 'claude-code', 'vscode', 'generic-http'] as const)
    expect(clientPresetInfo[preset].label).not.toBe(preset);
  expect(clientPresets).toContain('claude-desktop');
  expect(clientPresetInfo['claude-desktop'].label).toBe('Claude Desktop');
});

test('server name follows the Agent so two Agents never collide in one client', () => {
  expect(clientServerName({ id: 'a1b2c3d4-0000', name: 'Team KB' })).toBe('team-kb');
  expect(clientServerName({ id: 'a1b2c3d4-0000', name: '  Café / Docs (prod) ' })).toBe(
    'cafe-docs-prod',
  );
  expect(clientServerName({ id: 'a1b2c3d4-0000', name: '日常助手' })).toBe('platform-a1b2c3d4');
});

test('install links decode back to the exact URL-only config (Cursor base64, VS Code URI JSON)', () => {
  const url = 'https://mcp.example.test/mcp/0b9c5d6e-1111-4222-8333-444455556666';
  const [cursor] = installLinks({ preset: 'cursor', name: 'team-kb', url });
  const link = new URL(cursor!.href);
  expect(`${link.protocol}//${link.host}${link.pathname}`).toBe(
    'cursor://anysphere.cursor-deeplink/mcp/install',
  );
  expect(link.searchParams.get('name')).toBe('team-kb');
  expect(JSON.parse(Buffer.from(link.searchParams.get('config')!, 'base64').toString())).toEqual({
    url,
  });
  const [vscode, insiders] = installLinks({ preset: 'vscode', name: 'team-kb', url });
  for (const [entry, scheme] of [
    [vscode!, 'vscode:mcp/install?'],
    [insiders!, 'vscode-insiders:mcp/install?'],
  ] as const) {
    expect(entry.href.startsWith(scheme)).toBe(true);
    expect(JSON.parse(decodeURIComponent(entry.href.slice(scheme.length)))).toEqual({
      name: 'team-kb',
      type: 'http',
      url,
    });
  }
  expect(installLinks({ preset: 'claude-code', name: 'x', url })).toEqual([]);
});

test('OAuth exports carry no credential; key exports never get install links', async () => {
  const account = await h.signup();
  const profile = (await h.services.profiles.save(account.ownerId, { name: 'Team KB' }))!;
  const url = `${h.baseURL}/mcp/${profile.id}`;
  for (const preset of clientPresets) {
    const response = await account.request(
      `/profiles/${profile.id}/export?client=${preset}&auth=oauth`,
    );
    expect(response.status).toBe(200);
    const output = (await response.json()) as Output;
    expect(output).toMatchObject({ auth: 'oauth', credential: 'none', name: 'team-kb' });
    expect(output.config).toContain(url);
    expect(`${output.config}\n${output.command ?? ''}`).not.toMatch(/Authorization|Bearer|token/i);
    expect(output.notes).toBeTruthy();
    if (preset !== 'codex') expect(() => JSON.parse(output.config)).not.toThrow();
    expect(output.links.length > 0).toBe(preset === 'cursor' || preset === 'vscode');
    const key = (await (
      await account.request(`/profiles/${profile.id}/export?client=${preset}`)
    ).json()) as Output;
    expect(key).toMatchObject({ auth: 'key', credential: 'placeholder', links: [] });
  }
  const desktop = (await (
    await account.request(`/profiles/${profile.id}/export?client=claude-desktop&auth=oauth`)
  ).json()) as Output;
  expect(JSON.parse(desktop.config)).toEqual({
    mcpServers: { 'team-kb': { command: 'npx', args: ['-y', 'mcp-remote', url] } },
  });
  const issued = (await (
    await account.request(`/profiles/${profile.id}/keys`, { method: 'POST' })
  ).json()) as { token: string; exports: Output[] };
  const keyed = JSON.parse(issued.exports.find((e) => e.preset === 'claude-desktop')!.config);
  expect(keyed.mcpServers['team-kb']).toEqual({
    command: 'npx',
    args: ['-y', 'mcp-remote', url, '--header', 'Authorization:${AUTH_HEADER}'],
    env: { AUTH_HEADER: `Bearer ${issued.token}` },
  });
});

test('regenerating a key can revoke the old ones instead of piling up live keys', async () => {
  const account = await h.signup();
  const profile = (await h.services.profiles.save(account.ownerId, { name: 'Keys' }))!;
  const other = (await h.services.profiles.save(account.ownerId, { name: 'Other' }))!;
  const issue = async (id: string, body?: unknown) =>
    (await (
      await account.request(`/profiles/${id}/keys`, {
        method: 'POST',
        ...(body ? { body: JSON.stringify(body) } : {}),
      })
    ).json()) as { id: string; token: string; revoked: string[] };
  const active = async (id: string) =>
    (
      (await (await account.request('/profiles/keys/all')).json()) as {
        id: string;
        profileId: string;
        revoked: boolean;
      }[]
    )
      .filter((key) => key.profileId === id && !key.revoked)
      .map((key) => key.id);
  const first = await issue(profile.id);
  const second = await issue(profile.id, { replace: false });
  const untouched = await issue(other.id);
  expect((await active(profile.id)).sort()).toEqual([first.id, second.id].sort());
  const third = await issue(profile.id, { replace: true });
  expect(third.revoked.sort()).toEqual([first.id, second.id].sort());
  expect(await active(profile.id)).toEqual([third.id]);
  expect(await active(other.id)).toEqual([untouched.id]);
  await expect(h.services.profiles.authenticate(profile.id, first.token)).rejects.toThrow();
  await h.services.profiles.authenticate(profile.id, third.token);
  expect(
    (
      await account.request(`/profiles/${profile.id}/keys`, {
        method: 'POST',
        body: JSON.stringify({ replace: 'yes' }),
      })
    ).status,
  ).toBe(400);
});

test('URL-only OAuth works end to end with Cursor-style registration and shows the client and tools', async () => {
  const account = await h.signup();
  const connection = await h.services.connections.create(account.ownerId, {
    name: 'docs',
    adapter: 'direct',
    transport: 'http',
    mode: 'existing',
    url: upstream.url,
  });
  const [tool] = await h.services.connections.discover(account.ownerId, connection.id);
  const profile = (await h.services.profiles.save(account.ownerId, {
    name: 'OAuth agent',
    toolIds: [tool!.id],
  }))!;
  const resource = `${h.baseURL}/mcp/${profile.id}`;
  // Unauthenticated access advertises where to start OAuth.
  const challenge = await h.app.request(`/mcp/${profile.id}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
  });
  expect(challenge.status).toBe(401);
  expect(challenge.headers.get('www-authenticate')).toContain('resource_metadata=');
  const register = await h.app.request('/api/v1/oauth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: 'Cursor', redirect_uris: cursorRedirects }),
  });
  expect(register.status).toBe(201);
  const client = (await register.json()) as { client_id: string; redirect_uris: string[] };
  expect(client.redirect_uris).toEqual(cursorRedirects);
  for (const redirect of ['javascript:alert(1)', 'http://evil.example/cb', 'file:///tmp/x'])
    expect(
      (
        await h.app.request('/api/v1/oauth/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ client_name: 'bad', redirect_uris: [redirect] }),
        })
      ).status,
    ).toBeGreaterThanOrEqual(400);
  const verifier = randomBytes(32).toString('base64url');
  const query = new URLSearchParams({
    client_id: client.client_id,
    redirect_uri: 'http://localhost:8787/callback',
    response_type: 'code',
    code_challenge_method: 'S256',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    resource,
    state: 'state-1',
  });
  const details = (await (await account.request(`/oauth/consent?${query}`)).json()) as {
    clientName: string;
    profile: { name: string };
    tools: { name: string }[];
  };
  expect(details).toMatchObject({ clientName: 'Cursor', profile: { name: 'OAuth agent' } });
  expect(details.tools.map((row) => row.name)).toEqual(['docs__echo']);
  const consent = (await (
    await account.request('/oauth/consent', {
      method: 'POST',
      body: JSON.stringify(Object.fromEntries(query)),
    })
  ).json()) as { redirect: string };
  const redirect = new URL(consent.redirect);
  expect(`${redirect.origin}${redirect.pathname}`).toBe('http://localhost:8787/callback');
  const token = (await (
    await h.app.request('/api/v1/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: client.client_id,
        redirect_uri: 'http://localhost:8787/callback',
        code: redirect.searchParams.get('code')!,
        code_verifier: verifier,
        resource,
      }).toString(),
    })
  ).json()) as { access_token: string };
  const mcp = new Client({ name: 'oauth-url-only', version: '1' });
  await mcp.connect(
    new StreamableHTTPClientTransport(new URL(resource), {
      requestInit: { headers: { Authorization: `Bearer ${token.access_token}` } },
    }),
  );
  expect((await mcp.listTools()).tools.map((row) => row.name)).toEqual(['docs__echo']);
  await mcp.close();
});
