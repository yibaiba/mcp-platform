import { beforeAll, afterAll, expect, test, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { randomBytes, createHash } from 'node:crypto';
import { harness } from './harness.js';
import { fixtureMcp } from './fixtureMcp.js';
import { Vault } from '../apps/server/src/shared/crypto.js';
import { validatePackage } from '../apps/server/src/modules/skills/packageService.js';
let h: Awaited<ReturnType<typeof harness>>;
let fixture: Awaited<ReturnType<typeof fixtureMcp>>;
let account: Awaited<ReturnType<typeof h.signup>>;
beforeAll(async () => {
  h = await harness();
  fixture = await fixtureMcp();
  account = await h.signup();
});
afterAll(async () => {
  await h?.close();
  await fixture?.close();
});
test('Better Auth session and account isolation are enforced', async () => {
  expect((await h.app.request('/api/v1/connections')).status).toBe(401);
  const other = await h.signup();
  const connection = await h.services.connections.create(account.ownerId, {
    name: 'private',
    adapter: 'direct',
    transport: 'http',
    mode: 'existing',
    url: fixture.url,
  });
  expect(
    (await other.request(`/connections/${connection.id}/discover`, { method: 'POST' })).status,
  ).toBe(404);
  expect(
    (
      await h.app.request('/api/v1/devices/pairings', {
        method: 'POST',
        headers: {
          Cookie: account.cookie,
          Origin: 'https://evil.test',
          'Content-Type': 'application/json',
        },
        body: '{"name":"bad"}',
      })
    ).status,
  ).toBe(403);
});
test('official MCP client routes duplicate names and revocation takes effect immediately', async () => {
  const a = await h.services.connections.create(account.ownerId, {
    name: 'one',
    adapter: 'direct',
    transport: 'http',
    mode: 'existing',
    url: fixture.url,
  });
  const b = await h.services.connections.create(account.ownerId, {
    name: 'two',
    adapter: 'direct',
    transport: 'http',
    mode: 'existing',
    url: fixture.url,
  });
  const [first, second] = await Promise.all([
    h.services.connections.discover(account.ownerId, a.id),
    h.services.connections.discover(account.ownerId, b.id),
  ]);
  expect(first[0]!.id).not.toBe(second[0]!.id);
  const profile = (await h.services.profiles.save(account.ownerId, {
    name: 'external',
    toolIds: [first[0]!.id],
  }))!;
  const key = await h.services.profiles.issue(account.ownerId, profile.id);
  const client = new Client({ name: 'official-test', version: '1' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${h.baseURL}/mcp/${profile.id}`), {
      requestInit: { headers: { Authorization: `Bearer ${key.token}` } },
    }),
  );
  // Readable external name; the legacy `t_<sha256>` id is no longer listed but stays callable.
  expect((await client.listTools()).tools.map((t) => t.name)).toEqual(['one__echo']);
  const result = await client.callTool({
    name: 'one__echo',
    arguments: { message: 'real dispatch' },
  });
  expect(result.content).toEqual([{ type: 'text', text: 'real dispatch' }]);
  expect(
    (await client.callTool({ name: first[0]!.id, arguments: { message: 'legacy' } })).content,
  ).toEqual([{ type: 'text', text: 'legacy' }]);
  expect(result.structuredContent).toEqual({ name: 'echo' });
  await expect(client.callTool({ name: second[0]!.id, arguments: {} })).rejects.toThrow();
  await h.services.profiles.save(account.ownerId, { name: 'external', toolIds: [] }, profile.id);
  await expect(client.callTool({ name: first[0]!.id, arguments: {} })).rejects.toThrow();
  await h.services.profiles.revoke(account.ownerId, key.id);
  expect(
    (
      await fetch(`${h.baseURL}/mcp/${profile.id}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key.token}` },
      })
    ).status,
  ).toBe(401);
  await client.close();
});
test('pairing is single use and revoked device cannot authenticate', async () => {
  const pairing = await h.services.devices.createPairing(account.ownerId, 'device');
  const device = await h.services.devices.pair(pairing.code);
  await expect(h.services.devices.pair(pairing.code)).rejects.toThrow('配对码');
  expect(await h.services.devices.owned(account.ownerId, device.deviceId)).toBeDefined();
  await h.services.devices.revoke(account.ownerId, device.deviceId);
  await expect(h.services.devices.owned(account.ownerId, device.deviceId)).rejects.toThrow('撤销');
});
test('OAuth PKCE, resource binding, rotation and revocation', async () => {
  const profile = (await h.services.profiles.save(account.ownerId, {
    name: 'oauth',
    toolIds: [],
  }))!;
  const client = await h.services.agentOAuth.register({
    client_name: 'test',
    redirect_uris: ['http://127.0.0.1:8912/callback'],
  });
  const verifier = randomBytes(32).toString('base64url');
  const resource = `${h.baseURL}/mcp/${profile.id}`;
  const grant = await h.services.agentOAuth.consent(account.ownerId, {
    client_id: client.client_id,
    redirect_uri: client.redirect_uris[0],
    response_type: 'code',
    code_challenge_method: 'S256',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    resource,
    state: 'abc',
  });
  const code = new URL(grant.redirect).searchParams.get('code')!;
  const request = {
    grant_type: 'authorization_code',
    client_id: client.client_id,
    redirect_uri: client.redirect_uris[0]!,
    code,
    code_verifier: verifier,
    resource,
  };
  await expect(
    h.services.agentOAuth.token({
      ...request,
      code_verifier: randomBytes(32).toString('base64url'),
    }),
  ).rejects.toThrow('PKCE');
  const token = await h.services.agentOAuth.token(request);
  await expect(h.services.agentOAuth.token(request)).rejects.toThrow('授权码');
  await h.services.profiles.authenticate(profile.id, token.access_token);
  const sessionHeaders = { Authorization: `Bearer ${token.access_token}` };
  const oauthClient = new Client({ name: 'oauth-session-test', version: '1' });
  await oauthClient.connect(
    new StreamableHTTPClientTransport(new URL(resource), {
      requestInit: { headers: sessionHeaders },
    }),
  );
  expect((await oauthClient.listTools()).tools).toEqual([]);
  const refreshed = await h.services.agentOAuth.token({
    grant_type: 'refresh_token',
    client_id: client.client_id,
    refresh_token: token.refresh_token,
    resource,
  });
  await expect(
    h.services.agentOAuth.token({
      grant_type: 'refresh_token',
      client_id: client.client_id,
      refresh_token: token.refresh_token,
      resource,
    }),
  ).rejects.toThrow('已使用');
  await expect(h.services.profiles.authenticate(profile.id, token.access_token)).rejects.toThrow();
  sessionHeaders.Authorization = `Bearer ${refreshed.access_token}`;
  expect((await oauthClient.listTools()).tools).toEqual([]);
  await oauthClient.close();
  await h.services.agentOAuth.revoke(refreshed.refresh_token);
  await expect(
    h.services.profiles.authenticate(profile.id, refreshed.access_token),
  ).rejects.toThrow();
});
test('vault binds ciphertext to owner and connection; Skills reject unsafe paths', () => {
  const vault = new Vault(randomBytes(32).toString('base64'));
  const encrypted = vault.seal({ token: 'private' }, 'alice:one');
  expect(vault.open(encrypted, 'alice:one')).toEqual({ token: 'private' });
  expect(() => vault.open(encrypted, 'bob:one')).toThrow();
  expect(() => validatePackage({ name: 'test', files: { '../outside': '' } })).toThrow();
});
test('streamed artifacts enforce digest and owner isolation; disabled Agent tasks are explicit', async () => {
  const content = Buffer.from('file transfer');
  const sha256 = createHash('sha256').update(content).digest('hex');
  const body = () => new Response(content).body!;
  await expect(
    h.services.artifacts.upload(account.ownerId, {
      name: 'file.txt',
      sha256: '0'.repeat(64),
      body: body(),
    }),
  ).rejects.toThrow('SHA-256');
  const artifact = await h.services.artifacts.upload(account.ownerId, {
    name: 'file.txt',
    sha256,
    body: body(),
  });
  expect(await (await h.services.artifacts.download(account.ownerId, artifact.id)).text()).toBe(
    'file transfer',
  );
  const other = await h.signup();
  await expect(h.services.artifacts.download(other.ownerId, artifact.id)).rejects.toThrow();
  await expect(
    h.services.pi.start(account.ownerId, { profileId: crypto.randomUUID(), prompt: 'run' }),
  ).rejects.toThrow('内置 Agent 任务未启用');
});

test('Agent streams only explicitly granted artifact IDs and loses access on grant change', async () => {
  const bytes = Buffer.from('authorized artifact');
  const artifact = await h.services.artifacts.upload(account.ownerId, {
    name: 'result.txt',
    sha256: createHash('sha256').update(bytes).digest('hex'),
    body: new Response(bytes).body,
  });
  const profile = (await h.services.profiles.save(account.ownerId, {
    name: 'files',
    artifactIds: [artifact.id],
  }))!;
  const key = await h.services.profiles.issue(account.ownerId, profile.id);
  const get = () =>
    h.app.request(`/mcp/${profile.id}/artifacts/${artifact.id}`, {
      headers: { Authorization: `Bearer ${key.token}` },
    });
  expect(await (await get()).text()).toBe('authorized artifact');
  await h.services.profiles.save(account.ownerId, { name: 'files' }, profile.id);
  expect((await get()).status).toBe(403);
  const other = await h.signup();
  await expect(
    h.services.profiles.save(other.ownerId, { name: 'stolen', artifactIds: [artifact.id] }),
  ).rejects.toThrow('不属于');
});

test('cancellation is recorded as unknown and is never replayed', async () => {
  const connection = await h.services.connections.create(account.ownerId, {
    name: 'cancel',
    adapter: 'direct',
    transport: 'http',
    mode: 'existing',
    url: fixture.url,
  });
  const [tool] = await h.services.connections.discover(account.ownerId, connection.id);
  const abort = new AbortController();
  const initial = fixture.count();
  const result = h.services.invocations.call({
    ownerId: account.ownerId,
    toolId: tool!.id,
    arguments: { delay: 400 },
    signal: abort.signal,
  });
  const rejected = expect(result).rejects.toThrow();
  await vi.waitFor(() => expect(fixture.count()).toBe(initial + 1));
  abort.abort();
  await rejected;
  const logs = (await (await account.request('/calls')).json()) as {
    toolId: string;
    status: string;
  }[];
  expect(logs.find((call) => call.toolId === tool!.id)?.status).toBe('unknown');
  expect(fixture.count()).toBe(initial + 1);
});

test('legacy import validates every declaration before any connection is created', async () => {
  const before = await h.services.connections.list(account.ownerId);
  const response = await account.request('/import/apply', {
    method: 'POST',
    body: JSON.stringify({
      mcpServers: { valid: { url: fixture.url }, invalid: { url: 'invalid' } },
    }),
  });
  expect(response.status).toBe(400);
  expect(await h.services.connections.list(account.ownerId)).toHaveLength(before.length);
});
