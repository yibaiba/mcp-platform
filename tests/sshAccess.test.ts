import { afterAll, beforeAll, expect, test } from 'vitest';
import { unzipSync, strFromU8 } from 'fflate';
import { eq } from 'drizzle-orm';
import { user } from '../packages/db/src/index.js';
import { harness } from './harness.js';
import { fixtureMcp } from './fixtureMcp.js';
let h: Awaited<ReturnType<typeof harness>>;
let owner: Awaited<ReturnType<typeof h.signup>>;
let other: typeof owner;
let mcp: Awaited<ReturnType<typeof fixtureMcp>>;
beforeAll(async () => {
  h = await harness();
  owner = await h.signup();
  other = await h.signup();
  mcp = await fixtureMcp();
});
afterAll(async () => {
  await h?.close();
  await mcp?.close();
});
async function input(account = owner, host = 'ssh.example.test') {
  const { id } = await h.services.connections.create(account.ownerId, {
    name: 'SSH source',
    adapter: 'direct',
    transport: 'http',
    mode: 'existing',
    url: mcp.url,
    headers: { Authorization: 'Bearer never-in-bundle' },
  });
  const port = Number(new URL(mcp.url).port);
  return {
    name: 'workstation',
    platform: 'windows',
    ssh: {
      host,
      port: 22,
      username: 'mcp',
      identityFile: '~/.ssh/id_ed25519',
      reconnectIntervalSeconds: 5,
    },
    bindings: [{ connectionId: id, localPort: 3000, remotePort: port }],
  };
}
const write = (body: unknown, method = 'POST') => ({ method, body: JSON.stringify(body) });
test('owner isolation, bundle excludes credentials, MCP sharing does not grant SSH management', async () => {
  const config = await input();
  const saved = await owner.request('/ssh-accesses', write(config));
  expect(saved.status).toBe(201);
  const access = await saved.json();
  const rows = await (await owner.request('/ssh-accesses')).json();
  expect(rows[0]).toMatchObject({
    id: access.id,
    tunnelStatus: 'unreported',
    services: [{ configurationError: null }],
  });
  expect(await (await other.request('/ssh-accesses')).json()).toEqual([]);
  expect((await other.request(`/ssh-accesses/${access.id}/windows-bundle`)).status).toBe(404);
  expect(
    (await other.request(`/ssh-accesses/${access.id}`, write({ ...config, revision: 1 }, 'PUT')))
      .status,
  ).toBe(404);
  const tools = await h.services.connections.discover(
    owner.ownerId,
    config.bindings[0]!.connectionId,
  );
  const [recipient] = await h.db.select().from(user).where(eq(user.id, other.ownerId));
  const shared = await owner.request(
    `/connections/${config.bindings[0]!.connectionId}/shares`,
    write(
      { recipientEmail: recipient!.email, credentialMode: 'owner', toolIds: [tools[0]!.id] },
      'PUT',
    ),
  );
  expect(shared.status).toBe(200);
  await h.services.invocations.call({
    ownerId: other.ownerId,
    toolId: tools[0]!.id,
    arguments: { message: 'shared SSH MCP' },
  });
  expect(mcp.count()).toBe(1);
  expect((await other.request(`/ssh-accesses/${access.id}/windows-bundle`)).status).toBe(404);
  expect((await other.request('/ssh-accesses', write(config))).status).toBe(404);
  const bundle = await owner.request(`/ssh-accesses/${access.id}/windows-bundle`);
  expect(bundle.status).toBe(200);
  expect(bundle.headers.get('cache-control')).toBe('no-store');
  const files = unzipSync(new Uint8Array(await bundle.arrayBuffer()));
  expect(Object.keys(files).sort()).toEqual(
    [
      'Connect-McpPlatform.ps1',
      'Install-Startup.ps1',
      'README.txt',
      'Uninstall-Startup.ps1',
      'connection.json',
    ].sort(),
  );
  const exported = strFromU8(files['connection.json']!);
  expect(exported).not.toContain('never-in-bundle');
  expect(JSON.parse(exported).bindings).toEqual(config.bindings);
  expect(strFromU8(files['Connect-McpPlatform.ps1']!)).toContain(
    'StrictHostKeyChecking=$hostChecking',
  );
  expect(strFromU8(files['Install-Startup.ps1']!)).not.toContain('ExecutionPolicy');
});
test('global listener conflicts roll back updates; stale edits and deletions are rejected', async () => {
  const config = await input(owner, 'collision.test');
  const a = await (await owner.request('/ssh-accesses', write(config))).json();
  const conflict = await input(other, 'COLLISION.test');
  expect((await other.request('/ssh-accesses', write(conflict))).status).toBe(409);
  const independent = { ...conflict, ssh: { ...conflict.ssh, host: 'separate.test' } };
  const b = await (await other.request('/ssh-accesses', write(independent))).json();
  expect(
    (await other.request(`/ssh-accesses/${b.id}`, write({ ...conflict, revision: 1 }, 'PUT')))
      .status,
  ).toBe(409);
  expect((await (await other.request('/ssh-accesses')).json())[0]).toMatchObject({
    revision: 1,
    ssh: { host: 'separate.test' },
    bindings: independent.bindings,
  });
  expect(
    (
      await owner.request(
        `/ssh-accesses/${a.id}`,
        write({ ...config, name: 'updated', revision: 1 }, 'PUT'),
      )
    ).status,
  ).toBe(200);
  expect(
    (await owner.request(`/ssh-accesses/${a.id}`, write({ ...config, revision: 1 }, 'PUT'))).status,
  ).toBe(409);
  expect(
    (await owner.request(`/ssh-accesses/${a.id}`, write({ revision: 1 }, 'DELETE'))).status,
  ).toBe(409);
  expect(
    (await owner.request(`/ssh-accesses/${a.id}`, write({ revision: 2 }, 'DELETE'))).status,
  ).toBe(200);
  expect(
    await h.services.connections.owned(owner.ownerId, config.bindings[0]!.connectionId),
  ).toBeDefined();
});
test('validation rejects command injection, duplicate mappings and incompatible or changed connections', async () => {
  const config = await input(owner, 'validation.test');
  for (const patch of [
    { host: '-oProxyCommand=bad' },
    { host: 'bad;cmd' },
    { username: '-o' },
    { identityFile: 'key\ncmd' },
    { port: 65536 },
  ]) {
    expect(
      (await owner.request('/ssh-accesses', write({ ...config, ssh: { ...config.ssh, ...patch } })))
        .status,
    ).toBe(400);
  }
  expect(
    (
      await owner.request(
        '/ssh-accesses',
        write({ ...config, bindings: [...config.bindings, ...config.bindings] }),
      )
    ).status,
  ).toBe(400);
  const saved = await (await owner.request('/ssh-accesses', write(config))).json();
  await h.services.connections.update(owner.ownerId, config.bindings[0]!.connectionId, {
    url: 'http://127.0.0.1:1/mcp',
  });
  const rows = await (await owner.request('/ssh-accesses')).json();
  expect(
    rows.find((row: { id: string }) => row.id === saved.id).services[0].configurationError,
  ).toContain('远端端口');
  expect((await owner.request(`/ssh-accesses/${saved.id}/windows-bundle`)).status).toBe(400);
  expect((await owner.request('/ssh-accesses', write(config))).status).toBe(400);
});
