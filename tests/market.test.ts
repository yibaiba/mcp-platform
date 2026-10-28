import { afterAll, beforeAll, expect, test } from 'vitest';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { registryServer, marketSelection } from '../packages/contracts/src/index.js';
import { compileRegistry, distributionFields } from '../apps/server/src/modules/market/compiler.js';
import { MarketService } from '../apps/server/src/modules/market/marketService.js';
import { RegistryClient } from '../apps/server/src/modules/market/registryClient.js';
import { harness } from './harness.js';
import { fixtureMcp } from './fixtureMcp.js';

test('npm and PyPI compile pinned argv without shell splitting, with explicit unsupported and parameter errors', () => {
  const server = registryServer.parse({
    name: 'io.example/test',
    version: '1.2.3',
    description: 'Fixture',
    packages: [
      {
        registryType: 'npm',
        identifier: '@example/mcp',
        version: '1.2.3',
        transport: { type: 'stdio' },
        packageArguments: [
          { type: 'positional', valueHint: 'directory', isRequired: true },
          { type: 'named', name: '--token', isRequired: true, isSecret: true },
        ],
      },
      {
        registryType: 'pypi',
        identifier: 'example-mcp',
        version: '1.2.3',
        transport: { type: 'stdio' },
      },
      {
        registryType: 'oci',
        identifier: 'example',
        version: '1.2.3',
        transport: { type: 'stdio' },
      },
    ],
  });
  const selection = marketSelection.parse({
    serverName: server.name,
    version: server.version,
    distribution: 'package',
    index: 0,
    adapter: 'direct',
    name: 'Installed',
    values: {
      'args.0': '/tmp/directory with spaces; $(echo ignored)',
      'args.--token': 'private token',
    },
  });
  const config = compileRegistry(server, selection);
  expect(config.command).toBe('npx');
  expect(config.args).toEqual([
    '--yes',
    '@example/mcp@1.2.3',
    '/tmp/directory with spaces; $(echo ignored)',
    '--token',
    'private token',
  ]);
  expect(config.registry).toMatchObject({
    provider: 'official-registry',
    version: '1.2.3',
    packageVersion: '1.2.3',
  });
  expect(compileRegistry(server, { ...selection, index: 1, values: {} }).args).toEqual([
    '--from',
    'example-mcp==1.2.3',
    'example-mcp',
  ]);
  expect(() => compileRegistry(server, { ...selection, index: 2, values: {} })).toThrow(
    /不支持 oci/,
  );
  expect(() => compileRegistry(server, { ...selection, values: {} })).toThrow(/请填写/);
  expect(() => compileRegistry(server, { ...selection, version: 'latest' })).toThrow(
    /具体服务器版本/,
  );
  expect(distributionFields(server, selection).map((field) => field.key)).toEqual([
    'args.0',
    'args.--token',
  ]);
});

test('remote URL variables are encoded and input headers are exact; packaged HTTP requires a device', () => {
  const server = registryServer.parse({
    name: 'io.example/remote',
    version: '1',
    description: 'Remote',
    remotes: [
      {
        type: 'streamable-http',
        url: 'https://example.test/{tenant}',
        variables: { tenant: { isRequired: true } },
        headers: [{ name: 'X-Key', isRequired: true, isSecret: true }],
      },
    ],
    packages: [
      {
        registryType: 'npm',
        identifier: 'example-mcp',
        version: '1.0.0',
        transport: { type: 'sse', url: 'http://127.0.0.1:{--port}/sse' },
        packageArguments: [{ type: 'named', name: '--port', default: '4321' }],
      },
    ],
  });
  const input = marketSelection.parse({
    serverName: server.name,
    version: '1',
    distribution: 'remote',
    index: 0,
    adapter: 'direct',
    name: 'Remote',
    values: { 'url.tenant': 'a/b?c=d', 'headers.X-Key': 'private' },
  });
  expect(compileRegistry(server, input)).toMatchObject({
    url: 'https://example.test/a%2Fb%3Fc%3Dd',
    headers: { 'X-Key': 'private' },
  });
  expect(() => compileRegistry(server, { ...input, distribution: 'package', values: {} })).toThrow(
    /设备连接器/,
  );
  expect(
    compileRegistry(server, {
      ...input,
      distribution: 'package',
      adapter: 'device',
      deviceId: '00000000-0000-4000-8000-000000000001',
      values: {},
    }),
  ).toMatchObject({ transport: 'sse', mode: 'managed', url: 'http://127.0.0.1:4321/sse' });
});

let h: Awaited<ReturnType<typeof harness>>;
let fixture: Awaited<ReturnType<typeof fixtureMcp>>;
let registry: ReturnType<typeof serve>;
let service: MarketService;
let document: ReturnType<typeof registryServer.parse>;
const requests: URL[] = [];
beforeAll(async () => {
  h = await harness();
  fixture = await fixtureMcp();
  document = registryServer.parse({
    name: 'io.example/actual',
    version: '2.0.0',
    description: 'Network fixture',
    remotes: [{ type: 'streamable-http', url: fixture.url }],
  });
  const app = new Hono();
  app.get('*', (c) => {
    requests.push(new URL(c.req.url));
    return c.json(
      c.req.path.endsWith('/versions/2.0.0')
        ? { server: document }
        : { servers: [{ server: document }], metadata: { nextCursor: 'page-two' } },
    );
  });
  registry = serve({ port: 0, fetch: app.fetch });
  await new Promise<void>((resolve) => registry.once('listening', resolve));
  const address = registry.address();
  if (!address || typeof address === 'string') throw new Error('No registry address');
  service = new MarketService({
    registry: new RegistryClient({ fetch, baseUrl: `http://127.0.0.1:${address.port}/v0.1/` }),
    connections: h.services.connections,
  });
});
afterAll(async () => {
  await h?.close();
  await fixture?.close();
  if (registry) await new Promise<void>((resolve) => registry.close(() => resolve()));
});

test('real Registry HTTP paging retains filters and install only reports connected after real discovery', async () => {
  const { ownerId } = await h.signup();
  expect((await service.search({ search: 'actual', cursor: 'page-one' })).metadata.nextCursor).toBe(
    'page-two',
  );
  expect(requests.at(-1)!.searchParams.get('version')).toBe('latest');
  expect(requests.at(-1)!.searchParams.get('cursor')).toBe('page-one');
  const input = {
    serverName: document.name,
    version: '2.0.0',
    distribution: 'remote',
    index: 0,
    adapter: 'direct',
    name: 'Registry install',
  };
  const preview = await service.preview(ownerId, input);
  const installed = await service.install(ownerId, { ...input, previewHash: preview.previewHash });
  expect(installed).toMatchObject({ status: 'connected', tools: 1 });
  expect(fixture.count()).toBe(0);
  expect((await h.services.connections.list(ownerId))[0]!.registry).toMatchObject({
    version: '2.0.0',
  });
  document = {
    ...document,
    remotes: [
      { type: 'streamable-http', url: 'http://127.0.0.1:9/mcp', headers: [], variables: {} },
    ],
  };
  await expect(
    service.install(ownerId, { ...input, previewHash: preview.previewHash }),
  ).rejects.toMatchObject({ code: 'MARKET_PREVIEW_CHANGED' });
  const failedPreview = await service.preview(ownerId, input);
  const failed = await service.install(ownerId, {
    ...input,
    previewHash: failedPreview.previewHash,
  });
  expect(failed.status).toBe('error');
  expect((await h.services.connections.owned(ownerId, failed.connectionId)).status).toBe('error');
});

test('optional repository metadata may be empty without dropping a valid Registry entry', () => {
  expect(
    registryServer.parse({
      name: 'io.example/empty-repository',
      version: '1.0.0',
      description: 'Actual Registry metadata shape',
      repository: {},
      remotes: [{ type: 'streamable-http', url: 'https://example.test/mcp' }],
    }).repository,
  ).toEqual({});
});

test('Registry boolean flags and repeated templates preserve argv without dropping values', () => {
  const server = registryServer.parse({
    name: 'io.example/arguments',
    version: '1.0.0',
    description: 'Arguments',
    packages: [
      {
        registryType: 'npm',
        identifier: 'example',
        version: '1.0.0',
        transport: { type: 'stdio' },
        packageArguments: [
          { type: 'named', name: '--read-only', format: 'boolean' },
          {
            type: 'named',
            name: '--mount',
            value: '{source}:{target}',
            isRepeated: true,
            variables: { source: {}, target: {} },
          },
        ],
      },
    ],
  });
  const input = marketSelection.parse({
    serverName: server.name,
    version: server.version,
    distribution: 'package',
    index: 0,
    adapter: 'direct',
    name: 'Arguments',
    values: {
      'args.--read-only': 'true',
      'args.--mount.source': ['a a', 'b'],
      'args.--mount.target': '/workspace',
    },
  });
  expect(compileRegistry(server, input).args).toEqual([
    '--yes',
    'example@1.0.0',
    '--read-only',
    '--mount',
    'a a:/workspace',
    '--mount',
    'b:/workspace',
  ]);
  expect(
    compileRegistry(server, { ...input, values: { ...input.values, 'args.--read-only': 'false' } })
      .args,
  ).not.toContain('--read-only');
});
