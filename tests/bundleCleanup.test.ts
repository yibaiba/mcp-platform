import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { archive, manifest } from './fixtureBundle.js';
import { harness } from './harness.js';
import { mcpbInstalls } from '../packages/db/src/index.js';
import { BundleDiskStore } from '../apps/server/src/modules/bundles/diskStore.js';
import { DiskFileStore } from '../apps/server/src/modules/artifacts/fileStore.js';

let h: Awaited<ReturnType<typeof harness>>;
beforeAll(async () => {
  h = await harness();
});
afterAll(async () => {
  await h?.close();
});
afterEach(() => vi.restoreAllMocks());
const bytes = archive();
const destination = { adapter: 'direct', values: { key: 'cleanup-fixture' } };
const connectionConfig = {
  name: 'cleanup',
  source: 'mcp',
  adapter: 'direct',
  transport: 'stdio',
  mode: 'managed',
};
async function upload(ownerId: string, data = bytes) {
  return h.services.bundles.upload(ownerId, new Blob([new Uint8Array(data)]).stream());
}
const archivePath = (id: string) => join(h.directory, 'mcpb-archives', id);
async function receipt(input: {
  ownerId: string;
  packageId: string;
  connectionId?: string;
  revision?: number;
  state?: string;
}) {
  const id = randomUUID();
  // Persisted installation fixtures isolate cleanup from unrelated process shutdown behavior.
  await h.db.insert(mcpbInstalls).values({
    id,
    ownerId: input.ownerId,
    packageId: input.packageId,
    fingerprint: id,
    state: input.state ?? 'succeeded',
    connectionId: input.connectionId,
    connectionRevision: input.revision,
  });
  return id;
}

test('a replacement frees the old package while retaining the new connection and both receipts', async () => {
  const { ownerId } = await h.signup();
  const first = await upload(ownerId);
  const second = await upload(ownerId, archive({ ...manifest(), name: 'replacement-package' }));
  const firstPreview = await h.services.bundles.preview(ownerId, first.id, destination);
  const secondPreview = await h.services.bundles.preview(ownerId, second.id, destination);
  const connection = await h.services.connections.create(ownerId, {
    ...connectionConfig,
    ...firstPreview.config,
  });
  const oldReceipt = await receipt({
    ownerId,
    packageId: first.id,
    connectionId: connection.id,
    revision: connection.revision,
  });
  const changed = await h.services.connections.replace(ownerId, connection.id, {
    ...connectionConfig,
    ...secondPreview.config,
    revision: connection.revision,
  });
  const newReceipt = await receipt({
    ownerId,
    packageId: second.id,
    connectionId: connection.id,
    revision: changed.revision,
  });
  await expect(h.services.bundles.lifecycle.uninstall(ownerId, oldReceipt)).rejects.toMatchObject({
    code: 'MCPB_CONNECTION_CHANGED',
  });
  await expect(h.services.bundles.lifecycle.remove(ownerId, first.id)).resolves.toMatchObject({
    removed: true,
  });
  expect((await h.services.connections.owned(ownerId, connection.id)).revision).toBe(
    changed.revision,
  );
  for (const id of [oldReceipt, newReceipt])
    expect(await h.services.bundles.status(ownerId, id)).toMatchObject({
      connectionId: connection.id,
      state: 'succeeded',
    });
  await expect(h.services.bundles.lifecycle.remove(ownerId, second.id)).rejects.toMatchObject({
    code: 'MCPB_IN_USE',
  });
  expect(await readFile(archivePath(second.id))).toBeDefined();
});

test('renaming a connection still protects the package directory without a current receipt revision', async () => {
  const { ownerId } = await h.signup();
  const pkg = await upload(ownerId);
  const preview = await h.services.bundles.preview(ownerId, pkg.id, destination);
  const connection = await h.services.connections.create(ownerId, {
    ...connectionConfig,
    ...preview.config,
  });
  await receipt({
    ownerId,
    packageId: pkg.id,
    connectionId: connection.id,
    revision: connection.revision,
  });
  await h.services.connections.update(ownerId, connection.id, {
    name: 'renamed',
    revision: connection.revision,
  });
  await expect(h.services.bundles.lifecycle.remove(ownerId, pkg.id)).rejects.toMatchObject({
    code: 'MCPB_IN_USE',
  });
});

test.each(['/device/packages/', 'C:\\device\\packages\\'])(
  'device package directories remain protected after edits (%s)',
  async (prefix) => {
    const { ownerId } = await h.signup();
    const pkg = await upload(ownerId);
    const pairing = await h.services.devices.createPairing(ownerId, 'cleanup-device');
    const device = await h.services.devices.pair(pairing.code);
    const connection = await h.services.connections.create(ownerId, {
      ...connectionConfig,
      adapter: 'device',
      deviceId: device.deviceId,
      command: 'node',
      args: ['server.cjs'],
      cwd: `${prefix}${pkg.sha256}`,
    });
    await receipt({
      ownerId,
      packageId: pkg.id,
      connectionId: connection.id,
      revision: connection.revision,
    });
    await h.services.connections.update(ownerId, connection.id, {
      name: 'renamed',
      revision: connection.revision,
    });
    await expect(h.services.bundles.lifecycle.remove(ownerId, pkg.id)).rejects.toMatchObject({
      code: 'MCPB_IN_USE',
    });
  },
);

test('a running installation prevents cleanup before it has a connection', async () => {
  const { ownerId } = await h.signup();
  const pkg = await upload(ownerId);
  await receipt({ ownerId, packageId: pkg.id, state: 'running' });
  await expect(h.services.bundles.lifecycle.remove(ownerId, pkg.id)).rejects.toMatchObject({
    code: 'MCPB_IN_USE',
  });
  expect(await readFile(archivePath(pkg.id))).toEqual(Buffer.from(bytes));
});

test('failed directory cleanup retains the original and can be explicitly retried', async () => {
  const { ownerId } = await h.signup();
  const pkg = await upload(ownerId);
  const failure = Object.assign(new Error('directory removal denied'), { code: 'EACCES' });
  vi.spyOn(BundleDiskStore.prototype, 'remove').mockRejectedValueOnce(failure);
  await expect(h.services.bundles.lifecycle.remove(ownerId, pkg.id)).rejects.toBe(failure);
  expect(await readFile(archivePath(pkg.id))).toEqual(Buffer.from(bytes));
  expect((await h.services.bundles.lifecycle.history(ownerId)).packages[0]!.removedAt).toBeNull();
  await expect(h.services.bundles.lifecycle.remove(ownerId, pkg.id)).resolves.toMatchObject({
    removed: true,
  });
  await expect(readFile(archivePath(pkg.id))).rejects.toMatchObject({ code: 'ENOENT' });
});

test('same-digest reupload repairs missing bytes left by a previous interrupted cleanup', async () => {
  const { ownerId } = await h.signup();
  const pkg = await upload(ownerId);
  const operationId = await receipt({ ownerId, packageId: pkg.id, state: 'failed' });
  await rm(archivePath(pkg.id));
  expect((await h.services.bundles.lifecycle.history(ownerId)).packages[0]!.removedAt).toBeNull();
  const repaired = await upload(ownerId);
  expect(repaired.id).toBe(pkg.id);
  expect(await readFile(archivePath(pkg.id))).toEqual(Buffer.from(bytes));
  expect((await h.services.bundles.status(ownerId, operationId)).state).toBe('failed');
});

test('a failed reupload write propagates its error and never reports repaired bytes', async () => {
  const { ownerId } = await h.signup();
  const pkg = await upload(ownerId);
  await rm(archivePath(pkg.id));
  const failure = Object.assign(new Error('repair disk full'), { code: 'ENOSPC' });
  const write = DiskFileStore.prototype.write;
  vi.spyOn(DiskFileStore.prototype, 'write').mockImplementation(function (
    this: DiskFileStore,
    input,
  ) {
    if (input.id === pkg.id) return Promise.reject(failure);
    return write.call(this, input);
  });
  await expect(upload(ownerId)).rejects.toBe(failure);
  await expect(readFile(archivePath(pkg.id))).rejects.toMatchObject({ code: 'ENOENT' });
});

test('same-digest reupload does not invalidate the archive already opened by an installation', async () => {
  const { ownerId } = await h.signup();
  const data = archive();
  const upload = () =>
    h.services.bundles.upload(ownerId, new Blob([new Uint8Array(data)]).stream());
  const pkg = await upload();
  const destination = { adapter: 'direct', values: { key: 'review-fixture' } };
  const preview = await h.services.bundles.preview(ownerId, pkg.id, destination);
  let opened!: () => void, release!: () => void;
  const ready = new Promise<void>((resolve) => {
    opened = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const blob = DiskFileStore.prototype.blob;
  vi.spyOn(DiskFileStore.prototype, 'blob').mockImplementation(async function (
    this: DiskFileStore,
    id,
  ) {
    const result = await blob.call(this, id);
    if (id === pkg.id) {
      opened();
      await gate;
    }
    return result;
  });
  const installing = h.services.bundles
    .install(ownerId, pkg.id, {
      ...destination,
      operationId: randomUUID(),
      previewDigest: preview.previewDigest,
    })
    .then(
      (result) => ({ result }),
      (error) => ({ error }),
    );
  await ready;
  try {
    expect((await upload()).id).toBe(pkg.id);
  } finally {
    release();
  }
  const outcome = await installing;
  expect(outcome).toHaveProperty('result.state', 'succeeded');
});
