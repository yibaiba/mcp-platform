import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { unzipSync, zipSync, strToU8, strFromU8 } from 'fflate';
import { spawn, type ChildProcess } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import {
  compileBundle,
  mcpbManifest,
  type BundleEnvironment,
  type LocalState,
} from '../packages/contracts/src/index.js';
import { archive, manifest } from './fixtureBundle.js';
import { harness } from './harness.js';
let h: Awaited<ReturnType<typeof harness>>, child: ChildProcess;
beforeAll(async () => {
  h = await harness();
});
afterAll(async () => {
  if (child && child.exitCode === null) {
    const exited = new Promise<void>((done) => child.once('exit', () => done()));
    child.kill('SIGINT');
    await exited;
  }
  await h?.close();
});
async function management(config: string, dir: string) {
  child = spawn(
    resolve('connector/bin/connector'),
    ['manage', '--offline=false', '--config', config, '--data-dir', dir],
    {
      env: {
        ...process.env,
        HOME: h.directory,
        CODEX_HOME: join(h.directory, 'codex'),
        PI_CODING_AGENT_DIR: join(h.directory, 'pi'),
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    },
  );
  const opening = await new Promise<URL>((done, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('Local manager startup timed out')), 5000);
    child.once('error', reject);
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(
        new Error(
          `Local manager exited ${code}: ${output.replace(/#open=[a-f0-9]+/g, '#open=[redacted]')}`,
        ),
      );
    });
    child.stderr!.on('data', (data) => {
      output += data;
      const url = /http:\/\/127\.0\.0\.1:\d+\/#open=[a-f0-9]+/.exec(output)?.[0];
      if (url) {
        clearTimeout(timer);
        done(new URL(url));
      }
    });
  });
  const headers: Record<string, string> = {
    Origin: opening.origin,
    'Content-Type': 'application/json',
  };
  const session = await fetch(`${opening.origin}/local-api/v1/session`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ token: opening.hash.slice(6) }),
  });
  expect(session.status).toBe(200);
  headers.Cookie = session.headers
    .getSetCookie()
    .map((v) => v.split(';')[0])
    .join('; ');
  headers['X-CSRF-Token'] = (await session.json()).csrf;
  return async <T = unknown>(input: object): Promise<T> => {
    const response = await fetch(`${opening.origin}/local-api/v1/request`, {
      method: 'POST',
      headers,
      body: JSON.stringify(input),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    return result;
  };
}
test('local encrypted bundle joins inventory, syncs through HMAC, serves Profile and standalone clients, and invalidates after removal', async () => {
  const { ownerId } = await h.signup();
  const pairing = await h.services.devices.createPairing(ownerId, 'local bundle');
  const device = await h.services.devices.pair(pairing.code);
  const path = join(h.directory, 'config.json'),
    dir = join(h.directory, 'local');
  await writeFile(path, JSON.stringify({ server: h.baseURL, ...device }), { mode: 0o600 });
  const request = await management(path, dir);
  await vi.waitFor(() => expect(h.services.broker.online(device.deviceId)).toBe(true));
  const files = unzipSync(archive());
  files['server.cjs'] = strToU8(
    "console.error('credential=' + process.env.PRIVATE);\n" +
      strFromU8(files['server.cjs']!).replace(
        "case 'tools/call':result=",
        "case 'tools/call':if(r.params.arguments.fail){process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,error:{code:-32603,message:'fixture error '+process.env.PRIVATE}})+'\\n');return;}result=",
      ),
  );
  const bytes = zipSync(files),
    sha256 = createHash('sha256').update(bytes).digest('hex');
  const environment = await request<BundleEnvironment>({ action: 'mcpb.environment', id: sha256 });
  const launch = compileBundle({
    manifest: mcpbManifest.parse(manifest()),
    environment,
    values: { key: 'only-encrypted-local-secret' },
  });
  await request({
    action: 'mcpb.install',
    content: {
      sha256,
      archive: Buffer.from(bytes).toString('base64'),
      operationId: randomUUID(),
      config: { ...launch, mode: 'managed', transport: 'stdio' },
    },
  });
  const state = await request<LocalState>({ action: 'state' });
  const resource = Object.values(state.resources).find((r) => r.clients.includes('mcpb'))!;
  expect(resource).toBeDefined();
  expect(resource.selected).toBe(false);
  expect(resource.issues).toEqual([]);
  expect(JSON.stringify(state)).not.toContain('only-encrypted-local-secret');
  expect(await readFile(join(dir, 'manifest.json'), 'utf8')).not.toContain(
    'only-encrypted-local-secret',
  );
  await request({
    action: 'select',
    id: resource.id,
    selected: true,
    operationId: randomUUID(),
    expectedRevision: state.revision,
  });
  await h.services.local.sync.state(device.deviceId);
  let connectionId = '';
  await vi.waitFor(
    async () => {
      const bindings = await h.services.local.repository.list(ownerId, device.deviceId);
      connectionId = bindings.find((b) => b.resourceId === resource.id)?.connectionId ?? '';
      expect(connectionId).not.toBe('');
    },
    { timeout: 5000 },
  );
  const tools = await h.services.connections.discover(ownerId, connectionId);
  const profile = (await h.services.profiles.save(ownerId, {
    name: 'local-bundle-profile',
    toolIds: tools.map((t) => t.id),
  }))!;
  expect(
    await h.services.invocations.dispatch({
      ownerId,
      profileId: profile.id,
      toolId: tools[0]!.id,
      arguments: {},
    }),
  ).toMatchObject({ content: [{ text: 'fixture' }] });
  const failure = await h.services.invocations
    .dispatch({ ownerId, profileId: profile.id, toolId: tools[0]!.id, arguments: { fail: true } })
    .then(
      () => null,
      (error) => error as Error,
    );
  expect(failure).toBeInstanceOf(Error);
  expect(failure!.message).not.toContain('only-encrypted-local-secret');
  expect(failure!.message).toContain('[redacted]');
  const clientConfig = await request<{
    mcpServers: Record<string, { command: string; args: string[] }>;
  }>({ action: 'mcpb.client', id: sha256 });
  const descriptor = Object.values(clientConfig.mcpServers)[0] as {
    command: string;
    args: string[];
  };
  expect(JSON.stringify(descriptor)).not.toContain('only-encrypted-local-secret');
  const client = new Client(
    { name: 'bundle-client', version: '1' },
    { versionNegotiation: { mode: 'auto' } },
  );
  try {
    const transport = new StdioClientTransport({ ...descriptor, stderr: 'pipe' });
    let diagnostics = '';
    transport.stderr?.on('data', (chunk) => {
      diagnostics += chunk;
    });
    await client.connect(transport);
    await vi.waitFor(() => expect(diagnostics).toContain('credential=[redacted]'));
    expect(diagnostics).not.toContain('only-encrypted-local-secret');
    expect(await client.callTool({ name: 'echo', arguments: {} })).toMatchObject({
      content: [{ text: 'fixture' }],
    });
  } finally {
    await client.close();
  }
  const items = await request<{ revision: string }[]>({ action: 'mcpb.list' });
  await expect(
    h.services.local.request(ownerId, device.deviceId, {
      action: 'mcpb.remove',
      id: sha256,
      content: { revision: items[0]!.revision },
    }),
  ).rejects.toThrow();
  await request({ action: 'mcpb.remove', id: sha256, content: { revision: items[0]!.revision } });
  expect((await request<LocalState>({ action: 'state' })).resources[resource.id]!.deleted).toBe(
    true,
  );
  await expect(
    h.services.invocations.dispatch({
      ownerId,
      profileId: profile.id,
      toolId: tools[0]!.id,
      arguments: {},
    }),
  ).rejects.toThrow();
}, 25000);
