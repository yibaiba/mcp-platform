import { afterAll, beforeAll, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { archive, manifest } from './fixtureBundle.js';
import { harness } from './harness.js';
let h: Awaited<ReturnType<typeof harness>>;
beforeAll(async () => {
  h = await harness();
});
afterAll(async () => {
  await h?.close();
});
const target = { adapter: 'direct', values: { key: 'lifecycle-private' } };
const originalArchive = archive();
async function upload(ownerId: string, value?: unknown) {
  return h.services.bundles.upload(
    ownerId,
    new Blob([
      new Uint8Array(
        value === undefined ? originalArchive : archive(value as ReturnType<typeof manifest>),
      ),
    ]).stream(),
  );
}
async function install(ownerId: string, id: string) {
  const preview = await h.services.bundles.preview(ownerId, id, target);
  return h.services.bundles.install(ownerId, id, {
    ...target,
    operationId: randomUUID(),
    previewDigest: preview.previewDigest,
  });
}
test('history is owner scoped; uninstall cleans grants and package cleanup preserves receipts and permits reupload', async () => {
  const owner = await h.signup({ role: 'admin' }),
    other = await h.signup({ role: 'admin' });
  const pkg = await upload(owner.ownerId);
  const receipt = await install(owner.ownerId, pkg.id);
  const tool = (await h.services.profiles.catalog(owner.ownerId))[0]!;
  const profile = (await h.services.profiles.save(owner.ownerId, {
    name: 'installed',
    toolIds: [tool.id],
  }))!;
  const dependent = (await h.services.skills.import(owner.ownerId, {
    source: 'fixture',
    package: {
      name: 'bundle-dependent',
      files: {
        'SKILL.md': Buffer.from(
          '---\nname: bundle-dependent\ndescription: dependent fixture\n---\nUse the echo tool.',
        ).toString('base64'),
      },
      dependencies: [tool.id],
    },
  }))!;
  await h.services.profiles.save(
    owner.ownerId,
    {
      name: profile.name,
      toolIds: [tool.id],
      skillVersionIds: [dependent.id],
      revision: profile.revision,
    },
    profile.id,
  );
  const history = await h.services.bundles.lifecycle.history(owner.ownerId);
  expect(history.operations[0]).toMatchObject({
    id: receipt.id,
    state: 'succeeded',
    phase: 'complete',
    destination: 'direct',
  });
  expect(JSON.stringify(history)).not.toContain('lifecycle-private');
  expect((await other.request('/bundles/mcpb')).status).toBe(200);
  expect((await h.services.bundles.lifecycle.history(other.ownerId)).packages).toEqual([]);
  await expect(
    h.services.bundles.lifecycle.uninstall(other.ownerId, receipt.id),
  ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  await expect(h.services.bundles.lifecycle.remove(owner.ownerId, pkg.id)).rejects.toMatchObject({
    code: 'MCPB_IN_USE',
  });
  await h.services.bundles.lifecycle.uninstall(owner.ownerId, receipt.id);
  expect((await h.services.profiles.owned(owner.ownerId, profile.id)).toolIds).toEqual([]);
  const cleaned = await h.services.profiles.owned(owner.ownerId, profile.id);
  expect(cleaned.skillVersionIds).toEqual([]);
  expect((await h.services.skills.list(owner.ownerId)).map((s) => s.id)).toContain(dependent.id);
  await expect(
    h.services.profiles.save(
      owner.ownerId,
      { name: cleaned.name, revision: cleaned.revision },
      cleaned.id,
    ),
  ).resolves.toBeDefined();
  await expect(h.services.configExport.export(owner.ownerId, 'uninstalled')).resolves.toBeDefined();
  await h.services.bundles.lifecycle.remove(owner.ownerId, pkg.id);
  expect(
    (await h.services.bundles.lifecycle.history(owner.ownerId)).packages[0]!.removedAt,
  ).not.toBeNull();
  await expect(h.services.bundles.preview(owner.ownerId, pkg.id, target)).rejects.toMatchObject({
    code: 'MCPB_REMOVED',
  });
  expect((await upload(owner.ownerId)).id).toBe(pkg.id);
  expect((await install(owner.ownerId, pkg.id)).state).toBe('succeeded');
  expect((await h.services.bundles.status(owner.ownerId, receipt.id)).state).toBe('uninstalled');
});
test('an old installation receipt cannot uninstall an edited or replaced connection', async () => {
  const { ownerId } = await h.signup({ role: 'admin' });
  const pkg = await upload(ownerId),
    receipt = await install(ownerId, pkg.id);
  const connection = (await h.services.connections.list(ownerId))[0]!;
  await h.services.connections.update(ownerId, connection.id, {
    name: 'edited',
    revision: connection.revision,
  });
  await h.services.connections.discover(ownerId, connection.id);
  await expect(h.services.bundles.lifecycle.uninstall(ownerId, receipt.id)).rejects.toMatchObject({
    code: 'MCPB_CONNECTION_CHANGED',
  });
  expect(await h.services.connections.list(ownerId)).toMatchObject([
    { id: connection.id, status: 'connected' },
  ]);
});
test('runtime constraints are checked at installation with failure phase and sanitized cause retained', async () => {
  const { ownerId } = await h.signup({ role: 'admin' });
  const incompatible = await upload(ownerId, {
    ...manifest(),
    compatibility: { runtimes: { node: '>=999.0.0' } },
  });
  const preview = await h.services.bundles.preview(ownerId, incompatible.id, target);
  expect(await h.services.connections.list(ownerId)).toHaveLength(0);
  const operationId = randomUUID();
  await expect(
    h.services.bundles.install(ownerId, incompatible.id, {
      ...target,
      operationId,
      previewDigest: preview.previewDigest,
    }),
  ).rejects.toThrow('MCPB_RUNTIME_INCOMPATIBLE');
  expect(await h.services.bundles.status(ownerId, operationId)).toMatchObject({
    state: 'failed',
    phase: 'runtime',
    connectionId: null,
  });
  expect(JSON.stringify(await h.services.bundles.status(ownerId, operationId))).not.toContain(
    'lifecycle-private',
  );
  const badEnvironment = manifest();
  Object.assign(badEnvironment.server.mcp_config.env, {
    NODE_OPTIONS: '--invalid-runtime-test-option',
  });
  const unusable = await upload(ownerId, {
    ...badEnvironment,
    compatibility: { runtimes: { node: '>=22' } },
  });
  await expect(install(ownerId, unusable.id)).rejects.toThrow('MCPB_RUNTIME_UNAVAILABLE');
  const compatible = await upload(ownerId, {
    ...manifest(),
    compatibility: { runtimes: { node: '>=22 <99' } },
  });
  expect((await install(ownerId, compatible.id)).state).toBe('succeeded');
  const dynamic = await upload(ownerId, {
    ...manifest('npx'),
    compatibility: { runtimes: { node: '>=22' } },
  });
  await expect(h.services.bundles.preview(ownerId, dynamic.id, target)).rejects.toMatchObject({
    code: 'MCPB_RUNTIME_UNVERIFIABLE',
  });
});
