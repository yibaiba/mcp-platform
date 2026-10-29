import { afterAll, beforeAll, expect, test } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { archive, manifest } from './fixtureBundle.js';
import { execFileSync } from 'node:child_process';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { compileBundle, mcpbManifest } from '../packages/contracts/src/mcpb.js';
import { unpackBundle } from '../apps/server/src/modules/bundles/archive.js';
import { mcpbInstalls, mcpbPackages } from '../packages/db/src/index.js';
import { eq } from 'drizzle-orm';
import { harness } from './harness.js';
let h: Awaited<ReturnType<typeof harness>>;
beforeAll(async () => {
  h = await harness();
});
afterAll(async () => {
  await h?.close();
});
async function upload(ownerId: string, data = archive()) {
  return h.services.bundles.upload(ownerId, new Blob([new Uint8Array(data)]).stream());
}
test('compiler uses target overrides, typed values, argv arrays and redacted previews', () => {
  const value = mcpbManifest.parse({
    ...manifest(),
    user_config: {
      key: { type: 'string', sensitive: true },
      paths: { type: 'directory', multiple: true },
    },
  });
  value.server.mcp_config.args.push('${user_config.paths}');
  value.server.mcp_config.platform_overrides = { win32: { command: 'node.exe' } };
  const input = {
    manifest: value,
    environment: { platform: 'win32' as const, home: 'C:/Users/test', root: 'C:/bundles/pkg' },
    values: { key: 'secret', paths: ['C:/a b', 'C:/c'] },
  };
  expect(compileBundle(input)).toMatchObject({
    command: 'node.exe',
    args: ['C:/bundles/pkg/server.cjs', 'C:/a b', 'C:/c'],
    env: { PRIVATE: 'secret' },
  });
  expect(JSON.stringify(compileBundle({ ...input, redact: true }))).not.toContain('secret');
  expect(() => compileBundle({ ...input, values: { key: 10 } })).toThrow('类型');
  expect(() => mcpbManifest.parse({ ...manifest(), manifest_version: '0.4' })).toThrow();
});
test('archive rejects traversal, missing entry and duplicate names without execution', () => {
  expect(() => unpackBundle(zipSync({ '../escape': strToU8('bad') }))).toThrow();
  expect(() =>
    unpackBundle(zipSync({ 'manifest.json': strToU8(JSON.stringify(manifest())) })),
  ).toThrow('入口');
  expect(() => unpackBundle(new Uint8Array())).toThrow();
});
test('existing uploads preview and install archive arguments despite old parsed override defaults', async () => {
  const { ownerId } = await h.signup();
  const source = manifest();
  const platform = process.platform as 'darwin' | 'linux' | 'win32';
  const value = {
    ...source,
    server: {
      ...source.server,
      mcp_config: {
        ...source.server.mcp_config,
        platform_overrides: { [platform]: { command: process.execPath } },
      },
    },
  };
  const data = archive(value);
  const uploaded = await upload(ownerId, data);
  const legacy = structuredClone(uploaded.manifest);
  Object.assign(legacy.server.mcp_config.platform_overrides![platform]!, {
    args: [],
    env: {},
  });
  await h.db.update(mcpbPackages).set({ manifest: legacy }).where(eq(mcpbPackages.id, uploaded.id));
  const input = { adapter: 'direct', values: { key: 'test-value' } };
  const preview = await h.services.bundles.preview(ownerId, uploaded.id, input);
  expect(preview.config.args).toEqual([`${preview.config.cwd}/server.cjs`]);
  const duplicate = await upload(ownerId, data);
  expect(duplicate.id).toBe(uploaded.id);
  expect(duplicate.manifest.server.mcp_config.platform_overrides![platform]).not.toHaveProperty(
    'args',
  );
  const receipt = await h.services.bundles.install(ownerId, uploaded.id, {
    ...input,
    operationId: randomUUID(),
    previewDigest: preview.previewDigest,
  });
  expect(receipt.state).toBe('succeeded');
  expect((await h.services.profiles.catalog(ownerId))[0]!.name).toBe('echo');
});
test('platform preview does not start MCP; install discovers real tools and is idempotent', async () => {
  const { ownerId } = await h.signup();
  const pkg = await upload(ownerId);
  const input = { adapter: 'direct', values: { key: 'fixture-private' } };
  const preview = await h.services.bundles.preview(ownerId, pkg.id, input);
  expect(JSON.stringify(preview)).not.toContain('fixture-private');
  expect(await h.services.connections.list(ownerId)).toHaveLength(0);
  const operation = { ...input, operationId: randomUUID(), previewDigest: preview.previewDigest };
  const receipts = await Promise.all([
    h.services.bundles.install(ownerId, pkg.id, operation),
    h.services.bundles.install(ownerId, pkg.id, operation),
  ]);
  const installed = receipts.find((row) => row.state === 'succeeded')!;
  expect(installed.state).toBe('succeeded');
  expect((await h.services.profiles.catalog(ownerId))[0]!.name).toBe('echo');
  expect((await h.services.bundles.install(ownerId, pkg.id, operation)).connectionId).toBe(
    installed.connectionId,
  );
  expect(await h.services.connections.list(ownerId)).toHaveLength(1);
  expect(JSON.stringify(await h.services.connections.list(ownerId))).not.toContain(
    'fixture-private',
  );
  const other = await h.signup();
  await expect(h.services.bundles.preview(other.ownerId, pkg.id, input)).rejects.toThrow();
  await expect(h.services.bundles.status(other.ownerId, operation.operationId)).rejects.toThrow();
});
test('changed previews, offline devices and missing runtime report failure without fallback', async () => {
  const { ownerId } = await h.signup();
  const pkg = await upload(ownerId, archive(manifest('/definitely/missing/bundle-runtime')));
  const input = { adapter: 'direct', values: { key: 'private' } };
  const preview = await h.services.bundles.preview(ownerId, pkg.id, input);
  await expect(
    h.services.bundles.install(ownerId, pkg.id, {
      ...input,
      values: { key: 'changed' },
      operationId: randomUUID(),
      previewDigest: preview.previewDigest,
    }),
  ).rejects.toThrow('预览');
  const operationId = randomUUID();
  await expect(
    h.services.bundles.install(ownerId, pkg.id, {
      ...input,
      operationId,
      previewDigest: preview.previewDigest,
    }),
  ).rejects.toThrow();
  expect((await h.services.bundles.status(ownerId, operationId)).state).toBe('failed');
  const pairing = await h.services.devices.createPairing(ownerId, 'offline');
  const device = await h.services.devices.pair(pairing.code);
  await expect(
    h.services.bundles.preview(ownerId, pkg.id, {
      ...input,
      adapter: 'device',
      deviceId: device.deviceId,
    }),
  ).rejects.toThrow('离线');
});

test('replacement keeps its receipt across revisions and restart recovery never replays', async () => {
  const { ownerId } = await h.signup();
  const pkg = await upload(ownerId);
  const destination = { adapter: 'direct', values: { key: 'private' } };
  const preview = await h.services.bundles.preview(ownerId, pkg.id, destination);
  const first = await h.services.bundles.install(ownerId, pkg.id, {
    ...destination,
    operationId: randomUUID(),
    previewDigest: preview.previewDigest,
  });
  const connection = await h.services.connections.owned(ownerId, first.connectionId!);
  const replacement = {
    ...destination,
    operationId: randomUUID(),
    previewDigest: preview.previewDigest,
    connectionId: connection.id,
    revision: connection.revision,
  };
  expect((await h.services.bundles.install(ownerId, pkg.id, replacement)).state).toBe('succeeded');
  expect((await h.services.bundles.install(ownerId, pkg.id, replacement)).connectionId).toBe(
    connection.id,
  );
  await expect(
    h.services.bundles.install(ownerId, pkg.id, { ...replacement, operationId: randomUUID() }),
  ).rejects.toThrow('修订');
  await expect(
    h.services.bundles.install(ownerId, pkg.id, { ...replacement, values: { key: 'different' } }),
  ).rejects.toThrow('操作 ID');
  expect(await h.services.connections.list(ownerId)).toHaveLength(1);
  const interrupted = randomUUID();
  await h.db.insert(mcpbInstalls).values({
    id: interrupted,
    ownerId,
    packageId: pkg.id,
    fingerprint: 'fixture',
    state: 'running',
  });
  await h.services.bundles.recover();
  expect((await h.services.bundles.status(ownerId, interrupted)).state).toBe('unknown');
  expect(await h.services.connections.list(ownerId)).toHaveLength(1);
});
test('manifest defaults expand only environment variables, preserving literal user values', () => {
  const value = mcpbManifest.parse(manifest());
  value.user_config.key!.default = '${HOME}/private';
  const environment = { platform: 'linux' as const, home: '/home/test', root: '/bundle' };
  expect(compileBundle({ manifest: value, environment, values: {} }).env.PRIVATE).toBe(
    '/home/test/private',
  );
  expect(
    compileBundle({ manifest: value, environment, values: { key: '${HOME}/literal' } }).env.PRIVATE,
  ).toBe('${HOME}/literal');
  value.server.mcp_config.command = '${user_config.key}';
  expect(() => compileBundle({ manifest: value, environment, values: {} })).toThrow('敏感');
});

test('Pi installs the bundle and discovers tools without invoking a model', async () => {
  const { ownerId } = await h.signup();
  const pkg = await upload(ownerId);
  const destination = { adapter: 'pi', values: { key: 'private' } };
  const preview = await h.services.bundles.preview(ownerId, pkg.id, destination);
  expect(await h.services.connections.list(ownerId)).toHaveLength(0);
  const receipt = await h.services.bundles.install(ownerId, pkg.id, {
    ...destination,
    operationId: randomUUID(),
    previewDigest: preview.previewDigest,
  });
  expect(receipt.state).toBe('succeeded');
  expect((await h.services.profiles.catalog(ownerId))[0]!.name).toBe('echo');
}, 20000);

test('Python and native binary bundles launch their declared entry points', async () => {
  const source = `package main
import("bufio";"os";"encoding/json")
func main(){ s:=bufio.NewScanner(os.Stdin); e:=json.NewEncoder(os.Stdout); for s.Scan(){ var r struct{ID any;Method string;Params map[string]any}; if json.Unmarshal(s.Bytes(), &r)!=nil||r.ID==nil{continue}; result:=map[string]any{}; switch r.Method{case "initialize":result=map[string]any{"protocolVersion":r.Params["protocolVersion"],"capabilities":map[string]any{"tools":map[string]any{}},"serverInfo":map[string]any{"name":"native-fixture","version":"1"}};case "tools/list":result["tools"]=[]any{map[string]any{"name":"native","inputSchema":map[string]any{"type":"object"}}}};e.Encode(map[string]any{"jsonrpc":"2.0","id":r.ID,"result":result})} }
`;
  const code = join(h.directory, 'native.go'),
    binary = join(h.directory, 'native');
  await writeFile(code, source);
  execFileSync('go', ['build', '-o', binary, code], { timeout: 15000 });
  const python = `import sys,json
for line in sys.stdin:
 r=json.loads(line)
 if "id" not in r: continue
 result={}
 if r["method"]=="initialize": result={"protocolVersion":r["params"]["protocolVersion"],"capabilities":{"tools":{}},"serverInfo":{"name":"python-fixture","version":"1"}}
 if r["method"]=="tools/list": result={"tools":[{"name":"python","inputSchema":{"type":"object"}}]}
 print(json.dumps({"jsonrpc":"2.0","id":r["id"],"result":result}),flush=True)
`;
  for (const type of ['python', 'binary'] as const) {
    const { ownerId } = await h.signup();
    const entry = type === 'python' ? 'server.py' : 'native';
    const value = {
      ...manifest(),
      server: {
        type,
        entry_point: entry,
        mcp_config: {
          command: type === 'python' ? 'python3' : 'native',
          args: type === 'python' ? ['${__dirname}/server.py'] : [],
        },
      },
      user_config: {},
    };
    const data = zipSync({
      'manifest.json': strToU8(JSON.stringify(value)),
      [entry]: [
        type === 'python' ? strToU8(python) : new Uint8Array(await readFile(binary)),
        { os: 3, attrs: 0o100700 << 16 },
      ],
    });
    const pkg = await upload(ownerId, data);
    const destination = { adapter: 'direct', values: {} };
    const preview = await h.services.bundles.preview(ownerId, pkg.id, destination);
    const receipt = await h.services.bundles.install(ownerId, pkg.id, {
      ...destination,
      operationId: randomUUID(),
      previewDigest: preview.previewDigest,
    });
    expect(receipt.state).toBe('succeeded');
    expect((await h.services.profiles.catalog(ownerId))[0]!.name).toBe(
      type === 'binary' ? 'native' : type,
    );
  }
}, 20000);
