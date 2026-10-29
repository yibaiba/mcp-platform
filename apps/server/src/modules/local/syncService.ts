import type { LocalRequest, LocalResource, LocalState } from '@platform/contracts';
import { localOperation, localState } from '@platform/contracts';
import type { DeviceBroker } from '../devices/deviceBroker.js';
import { AppError } from '../../shared/errors.js';
import { LocalRepository, equal, metadata, type Binding } from './repository.js';
import { LocalMaterializer } from './materializer.js';

export class LocalSyncService {
  constructor(
    private readonly deps: {
      repository: LocalRepository;
      broker: DeviceBroker;
      materializer: LocalMaterializer;
    },
  ) {}
  async state(deviceId: string) {
    return localState.parse(
      await this.deps.broker.request(deviceId, {
        method: 'local.request',
        params: { action: 'state' },
      }),
    );
  }
  async reconcile(ownerId: string, deviceId: string) {
    const state = await this.state(deviceId);
    await this.deps.repository.snapshot(ownerId, deviceId, state);
    const errors: string[] = [];
    for (const row of await this.deps.repository.list(ownerId, deviceId)) {
      const resource = state.resources[row.resourceId];
      if (!resource || !resource.selected) {
        if (row.active)
          await this.deps.repository.patch(row, { active: false, status: 'unlinked' });
        continue;
      }
      if (!row.active) {
        await this.deps.repository.patch(row, { active: true, status: 'pending' });
        continue;
      }
      try {
        await this.reconcileResource(row, resource);
      } catch (error) {
        const message =
          error instanceof AppError ? error.message : '同步失败，请检查平台和本机操作记录';
        const current = await this.deps.repository.owned(ownerId, { deviceId, id: row.id });
        await this.deps.repository.patch(current, {
          status:
            error instanceof AppError &&
            ['SYNC_CONNECTION_CONFLICT', 'SYNC_RESOURCE_CONFLICT'].includes(error.code)
              ? 'conflict'
              : 'error',
          error: message,
        });
        errors.push(`${resource.name}: ${message}`);
      }
    }
    if (errors.length) throw new AppError('LOCAL_SYNC_FAILED', errors.join('; '), 409);
  }
  private async reconcileResource(row: Binding, resource: LocalResource) {
    if (row.status === 'conflict' || row.status === 'deletion_pending' || row.status === 'deleted')
      return;
    if (resource.issues.length) {
      if (row.error !== resource.issues.join('; '))
        await this.deps.repository.patch(row, {
          status: 'error',
          error: resource.issues.join('; '),
        });
      return;
    }
    if (resource.deleted || row.deleted) {
      await this.deps.repository.patch(row, {
        status: 'deletion_pending',
        metadata: metadata(resource),
      });
      return;
    }
    const localChanged = resource.digest !== row.localDigest;
    const platformChanged = !equal(row.content, row.baseline);
    if (localChanged && platformChanged && !equal(resource.content, row.content)) {
      await this.deps.repository.patch(row, {
        status: 'conflict',
        metadata: metadata(resource),
        error: '本机与平台均有修改，请比较差异',
      });
      return;
    }
    if (!localChanged && !platformChanged && row.status === 'synced') return;
    let current = resource;
    if (platformChanged && !equal(resource.content, row.content)) {
      const latest = await this.state(row.deviceId);
      const target = latest.resources[row.resourceId];
      if (!target || target.deleted || !target.selected || target.digest !== resource.digest)
        throw new AppError('SYNC_RESOURCE_CONFLICT', '同步期间本机资源已改变，请比较差异', 409);
      await this.apply(row, latest, {
        action: 'edit',
        content: row.content,
      });
      current = (await this.state(row.deviceId)).resources[row.resourceId]!;
    }
    const published = await this.deps.materializer.publish(row, current);
    await this.deps.repository.patch(row, {
      ...published,
      baseline: current.content,
      content: current.content,
      localDigest: current.digest,
      metadata: metadata(current),
      status: 'synced',
      error: null,
    });
  }
  async apply(row: Binding, state: LocalState, patch: Partial<LocalRequest>) {
    const resource = state.resources[row.resourceId];
    if (!resource) throw new AppError('LOCAL_RESOURCE_MISSING', '本机资源不可用', 409);
    const operationId = `sync:${row.id}:${row.revision}:${patch.action}`;
    const input = {
      action: patch.action!,
      id: resource.id,
      expectedRevision: state.revision,
      expectedDigest: resource.digest,
      operationId,
      ...patch,
    };
    const op =
      (await this.deps.repository.existingOperation(row.ownerId, row.deviceId, operationId)) ??
      (await this.deps.repository.operation(row.ownerId, {
        deviceId: row.deviceId,
        key: operationId,
        action: 'sync.apply',
        payload: input,
      }));
    if (op.phase === 'succeeded') return;
    // A retry uses the original input, including its baseline. Device-side idempotency
    // reconciles a committed file write after a dropped reply or connector restart.
    const result = localOperation.parse(
      await this.deps.broker.request(row.deviceId, { method: 'local.request', params: op.input }),
    );
    if (result.phase !== 'succeeded')
      throw new AppError('SYNC_INCOMPLETE', result.error ?? `设备操作状态：${result.phase}`, 409);
    await this.deps.repository.finish(op.id, { phase: 'succeeded', result });
  }
}
