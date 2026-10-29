import { afterEach, expect, test, vi } from 'vitest';
import type { LocalResource, LocalState } from '../packages/contracts/src/index.js';
import { LocalSyncService } from '../apps/server/src/modules/local/syncService.js';
import {
  LocalRepository,
  metadata,
  type Binding,
} from '../apps/server/src/modules/local/repository.js';
import { LocalMaterializer } from '../apps/server/src/modules/local/materializer.js';
import { DeviceBroker } from '../apps/server/src/modules/devices/deviceBroker.js';

afterEach(() => vi.restoreAllMocks());

function fixture() {
  const resource: LocalResource = {
    id: 'resource',
    kind: 'mcp',
    name: 'local',
    description: '',
    sourceIds: [],
    clients: ['cursor'],
    path: '/mcp.json',
    realPath: '/mcp.json',
    digest: 'baseline',
    fileDigest: 'baseline-file',
    content: { description: 'baseline' },
    readOnly: false,
    deleted: false,
    selected: true,
    reloadRequired: false,
    loadedVerified: false,
    programExists: true,
    runtime: 'stopped',
    issues: [],
  };
  const state: LocalState = {
    revision: 1,
    identityResources: {},
    sources: [],
    resources: { [resource.id]: resource },
    operations: {},
    issues: [],
  };
  const row: Binding = {
    id: 'binding',
    ownerId: 'owner',
    deviceId: 'device',
    resourceId: resource.id,
    metadata: metadata(resource),
    baseline: resource.content,
    content: { description: 'platform' },
    localDigest: resource.digest,
    revision: 2,
    active: true,
    deleted: false,
    status: 'pending',
    error: null,
    connectionId: null,
    connectionRevision: null,
    skillVersionId: null,
    updatedAt: new Date(),
  };
  // Isolate reconciliation from database/device effects; all used methods are explicit spies.
  const repository = Object.create(LocalRepository.prototype) as LocalRepository;
  const materializer = Object.create(LocalMaterializer.prototype) as LocalMaterializer;
  const broker = Object.create(DeviceBroker.prototype) as DeviceBroker;
  vi.spyOn(repository, 'snapshot').mockResolvedValue();
  vi.spyOn(repository, 'list').mockResolvedValue([row]);
  vi.spyOn(repository, 'owned').mockResolvedValue(row);
  const patch = vi
    .spyOn(repository, 'patch')
    .mockImplementation(async (value, change) => ({ ...value, ...change }));
  const publish = vi
    .spyOn(materializer, 'publish')
    .mockResolvedValue({ connectionId: 'connection', connectionRevision: 1 });
  const service = new LocalSyncService({ repository, materializer, broker });
  const read = vi.spyOn(service, 'state').mockResolvedValue(state);
  const apply = vi.spyOn(service, 'apply').mockResolvedValue();
  return { resource, state, row, service, read, apply, publish, patch };
}

test('a local edit between conflict detection and writeback is not overwritten', async () => {
  const f = fixture();
  const edited = { ...f.resource, digest: 'external', content: { description: 'external' } };
  f.read.mockResolvedValueOnce(f.state).mockResolvedValue({
    ...f.state,
    revision: 2,
    resources: { [edited.id]: edited },
  });

  await expect(f.service.reconcile('owner', 'device')).rejects.toMatchObject({
    code: 'LOCAL_SYNC_FAILED',
  });
  expect(f.apply).not.toHaveBeenCalled();
  expect(f.publish).not.toHaveBeenCalled();
  expect(f.patch).toHaveBeenCalledWith(f.row, expect.objectContaining({ status: 'conflict' }));
  expect(edited.content.description).toBe('external');
});

test.each(['removed', 'deleted', 'unselected'] as const)(
  '%s resource during writeback is reported as a conflict',
  async (change) => {
    const f = fixture();
    const resources =
      change === 'removed'
        ? {}
        : {
            [f.resource.id]: {
              ...f.resource,
              deleted: change === 'deleted',
              selected: change !== 'unselected',
            },
          };
    f.read.mockResolvedValueOnce(f.state).mockResolvedValue({ ...f.state, revision: 2, resources });
    await expect(f.service.reconcile('owner', 'device')).rejects.toMatchObject({
      code: 'LOCAL_SYNC_FAILED',
    });
    expect(f.apply).not.toHaveBeenCalled();
    expect(f.patch).toHaveBeenCalledWith(f.row, expect.objectContaining({ status: 'conflict' }));
  },
);

test('unrelated inventory revisions still allow writing an unchanged target', async () => {
  const f = fixture();
  const latest = { ...f.state, revision: 2 };
  const written = { ...f.resource, digest: 'written', content: f.row.content };
  f.read
    .mockResolvedValueOnce(f.state)
    .mockResolvedValueOnce(latest)
    .mockResolvedValue({
      ...latest,
      revision: 3,
      resources: { [written.id]: written },
    });
  await f.service.reconcile('owner', 'device');
  expect(f.apply).toHaveBeenCalledWith(f.row, latest, { action: 'edit', content: f.row.content });
  expect(f.publish).toHaveBeenCalledWith(f.row, written);
  expect(f.patch).toHaveBeenCalledWith(
    f.row,
    expect.objectContaining({ status: 'synced', localDigest: 'written' }),
  );
});
