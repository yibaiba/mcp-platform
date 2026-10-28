import { beforeAll, afterAll, test, expect, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { harness } from './harness.js';
import { fixtureMcp } from './fixtureMcp.js';
import { fixtureSseMcp } from './fixtureSseMcp.js';
import { filesDigest } from '../apps/server/src/modules/skills/packageService.js';
let h: Awaited<ReturnType<typeof harness>>;
let fixture: Awaited<ReturnType<typeof fixtureMcp>>;
let sseFixture: Awaited<ReturnType<typeof fixtureSseMcp>>;
let account: Awaited<ReturnType<typeof h.signup>>;
const processes: ChildProcess[] = [];
const deviceIds: string[] = [];
const roots: string[] = [];
beforeAll(async () => {
  h = await harness();
  fixture = await fixtureMcp();
  sseFixture = await fixtureSseMcp();
  account = await h.signup();
  for (let i = 0; i < 2; i++) {
    const pair = await h.services.devices.createPairing(account.ownerId, `connector-${i}`);
    const device = await h.services.devices.pair(pair.code);
    deviceIds.push(device.deviceId);
    const root = join(h.directory, `device-${i}`);
    roots.push(root);
    await mkdir(root);
    const config = join(root, 'connector.json');
    await writeFile(
      config,
      JSON.stringify({
        server: h.baseURL,
        deviceId: device.deviceId,
        deviceSecret: device.deviceSecret,
        credentialVersion: device.credentialVersion,
        skillRoots: { claude: join(root, '.claude', 'skills') },
        artifactRoots: { workspace: root },
      }),
      { mode: 0o600 },
    );
    const child = spawn(resolve('connector/bin/connector'), ['run', '--config', config], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    child.stderr?.on('data', (data: Buffer) => process.stderr.write(data));
    processes.push(child);
  }
  await vi.waitFor(
    () => {
      expect(deviceIds.every((id) => h.services.broker.online(id))).toBe(true);
    },
    { timeout: 5000 },
  );
});
afterAll(async () => {
  for (const child of processes) child.kill('SIGINT');
  await Promise.all(
    processes.map((child) =>
      child.exitCode !== null || child.signalCode !== null
        ? Promise.resolve()
        : new Promise<void>((resolve) => child.once('exit', () => resolve())),
    ),
  );
  await h?.close();
  await fixture?.close();
  await sseFixture?.close();
});
test('connect pairs a new device, starts its channel and reuses its configuration on restart', async () => {
  const pair = await h.services.devices.createPairing(account.ownerId, 'single-command-device');
  const config = join(h.directory, 'single-command', 'connector.json');
  const start = (code?: string) => {
    const child = spawn(
      resolve('connector/bin/connector'),
      ['connect', '--server', h.baseURL, '--config', config],
      { stdio: ['pipe', 'ignore', 'pipe'] },
    );
    processes.push(child);
    child.stderr?.on('data', (data: Buffer) => process.stderr.write(data));
    child.stdin?.end(code ? `${code}\n` : undefined);
    return child;
  };
  const first = start(pair.code);
  let deviceId: string;
  await vi.waitFor(
    async () => {
      const saved = JSON.parse(await readFile(config, 'utf8')) as { deviceId: string };
      deviceId = saved.deviceId;
      expect(h.services.broker.online(deviceId)).toBe(true);
    },
    { timeout: 5000 },
  );
  const original = await readFile(config, 'utf8');
  const exit = new Promise<void>((resolve) => first.once('exit', () => resolve()));
  first.kill('SIGINT');
  await exit;
  await expect.poll(() => h.services.broker.online(deviceId!)).toBe(false);
  start();
  await expect.poll(() => h.services.broker.online(deviceId!), { timeout: 5000 }).toBe(true);
  expect(await readFile(config, 'utf8')).toBe(original);
  expect(
    (await h.services.devices.list(account.ownerId)).filter(
      (d) => d.name === 'single-command-device',
    ),
  ).toHaveLength(1);
});
test('one official client reaches remote MCP and two independent Go connector processes', async () => {
  const ids: string[] = [];
  for (const deviceId of [undefined, ...deviceIds]) {
    const connection = await h.services.connections.create(account.ownerId, {
      name: deviceId ?? 'remote',
      adapter: deviceId ? 'device' : 'direct',
      deviceId,
      transport: 'http',
      mode: 'existing',
      url: fixture.url,
    });
    const catalog = await h.services.connections.discover(account.ownerId, connection.id);
    ids.push(catalog[0]!.id);
  }
  expect(new Set(ids).size).toBe(3);
  const profile = (await h.services.profiles.save(account.ownerId, {
    name: 'all locations',
    toolIds: ids,
  }))!;
  const key = await h.services.profiles.issue(account.ownerId, profile.id);
  const client = new Client({ name: 'cross-device-test', version: '1' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${h.baseURL}/mcp/${profile.id}`), {
      requestInit: { headers: { Authorization: `Bearer ${key.token}` } },
    }),
  );
  expect((await client.listTools()).tools).toHaveLength(3);
  for (const [index, id] of ids.entries())
    expect(
      (await client.callTool({ name: id, arguments: { message: `location-${index}` } })).content,
    ).toEqual([{ type: 'text', text: `location-${index}` }]);
  await client.close();
});
test('Go device connector discovers and calls legacy SSE tools', async () => {
  const connection = await h.services.connections.create(account.ownerId, {
    name: 'device SSE',
    adapter: 'device',
    deviceId: deviceIds[0],
    transport: 'sse',
    mode: 'existing',
    url: sseFixture.url,
  });
  const [tool] = await h.services.connections.discover(account.ownerId, connection.id);
  expect(tool?.name).toBe('echo');
  expect(
    await h.services.invocations.call({
      ownerId: account.ownerId,
      toolId: tool!.id,
      arguments: { message: 'Go SSE' },
    }),
  ).toMatchObject({ content: [{ type: 'text', text: 'Go SSE' }] });
  const callsBefore = sseFixture.count();
  const abort = new AbortController();
  const pending = h.services.invocations.call({
    ownerId: account.ownerId,
    toolId: tool!.id,
    arguments: { message: 'cancel SSE', delay: 500 },
    signal: abort.signal,
  });
  const cancelled = expect(pending).rejects.toThrow('结果');
  await expect.poll(() => sseFixture.count()).toBe(callsBefore + 1);
  abort.abort();
  await cancelled;
  expect(
    await h.services.invocations.call({
      ownerId: account.ownerId,
      toolId: tool!.id,
      arguments: { message: 'SSE session survives' },
    }),
  ).toMatchObject({ content: [{ type: 'text', text: 'SSE session survives' }] });
  await h.services.connections.stop(account.ownerId, connection.id);
});
test('file flows from connector A through checksum storage to connector B', async () => {
  const content = 'cross-process file, SHA-256 verified';
  await writeFile(join(roots[0]!, 'source.txt'), content);
  const upload = await h.services.artifacts.transfer(account.ownerId, {
    deviceId: deviceIds[0]!,
    direction: 'send',
    root: 'workspace',
    path: 'source.txt',
  });
  const artifact = upload.result as { id: string };
  await h.services.artifacts.transfer(account.ownerId, {
    deviceId: deviceIds[1]!,
    artifactId: artifact.id,
    direction: 'receive',
    root: 'workspace',
    path: 'received.txt',
  });
  expect(await readFile(join(roots[1]!, 'received.txt'), 'utf8')).toBe(content);
});
test('Skill installation, rollback and user-file conflict use real filesystem', async () => {
  const profile = (await h.services.profiles.save(account.ownerId, {
    name: 'skills',
    toolIds: [],
  }))!;
  const files = {
    'SKILL.md': Buffer.from(
      '---\nname: example\ndescription: Integration example\n---\nVersion one',
    ).toString('base64'),
  };
  const first = (await h.services.skills.import(account.ownerId, {
    source: 'integration',
    package: { name: 'example', files },
  }))!;
  expect(first.digest).toBe(filesDigest(files));
  await h.services.skills.install(account.ownerId, {
    versionId: first.id,
    profileId: profile.id,
    deviceId: deviceIds[0]!,
    target: 'claude',
  });
  const secondFiles = {
    'SKILL.md': Buffer.from(
      '---\nname: example\ndescription: Integration example\n---\nVersion two',
    ).toString('base64'),
  };
  const second = (await h.services.skills.import(account.ownerId, {
    source: 'integration',
    package: { name: 'example', files: secondFiles },
  }))!;
  await h.services.skills.install(account.ownerId, {
    versionId: second.id,
    profileId: profile.id,
    deviceId: deviceIds[0]!,
    target: 'claude',
  });
  await h.services.skills.install(account.ownerId, {
    versionId: first.id,
    profileId: profile.id,
    deviceId: deviceIds[0]!,
    target: 'claude',
  });
  const installed = join(roots[0]!, '.claude', 'skills', 'example', 'SKILL.md');
  expect(await readFile(installed, 'utf8')).toContain('Version one');
  await writeFile(installed, 'user edit');
  await expect(
    h.services.skills.install(account.ownerId, {
      versionId: second.id,
      profileId: profile.id,
      deviceId: deviceIds[0]!,
      target: 'claude',
    }),
  ).rejects.toThrow('USER_CONFLICT');
  expect(await readFile(installed, 'utf8')).toBe('user edit');
});
test('disconnect does not replay an in-flight tool and reports unknown result', async () => {
  const connection = await h.services.connections.create(account.ownerId, {
    name: 'disconnect',
    adapter: 'device',
    deviceId: deviceIds[1],
    transport: 'http',
    mode: 'existing',
    url: fixture.url,
  });
  const [tool] = await h.services.connections.discover(account.ownerId, connection.id);
  const before = fixture.count();
  const pending = h.services.invocations.call({
    ownerId: account.ownerId,
    toolId: tool!.id,
    arguments: { delay: 800 },
  });
  const assertion = expect(pending).rejects.toThrow('中断');
  await expect.poll(() => fixture.count(), { timeout: 2000 }).toBe(before + 1);
  h.services.broker.disconnect(deviceIds[1]!);
  await assertion;
  await new Promise((resolve) => setTimeout(resolve, 1000));
  expect(fixture.count()).toBe(before + 1);
});

test('device starts a real stdio MCP subprocess and stopping it makes calls unavailable', async () => {
  const connection = await h.services.connections.create(account.ownerId, {
    name: 'local stdio',
    adapter: 'device',
    deviceId: deviceIds[0],
    transport: 'stdio',
    mode: 'managed',
    command: process.execPath,
    args: ['--import', 'tsx', resolve('tests/fixtureStdio.mts')],
    cwd: resolve('.'),
  });
  const [tool] = await h.services.connections.discover(account.ownerId, connection.id);
  const result = await h.services.invocations.call({
    ownerId: account.ownerId,
    toolId: tool!.id,
    arguments: { message: 'stdio-real' },
  });
  expect(result.content).toEqual([{ type: 'text', text: 'stdio-real' }]);
  await h.services.connections.stop(account.ownerId, connection.id);
  await expect(
    h.services.invocations.call({ ownerId: account.ownerId, toolId: tool!.id, arguments: {} }),
  ).rejects.toThrow('已停止');
});
