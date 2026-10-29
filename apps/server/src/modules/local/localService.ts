import type { DiagnosticLogger } from '../activity/systemLogger.js';
import { and, eq } from 'drizzle-orm';
import { devices, localSources, type Database } from '@platform/db';
import {
  localRequest,
  localBindingMutation,
  type LocalBindingMutation,
  type LocalState,
} from '@platform/contracts';
import type { DeviceBroker } from '../devices/deviceBroker.js';
import type { DeviceService } from '../devices/deviceService.js';
import type { ConnectionService } from '../mcp/connectionService.js';
import type { SkillService } from '../skills/skillService.js';
import { AppError, errorMessage } from '../../shared/errors.js';
import { LocalRepository } from './repository.js';
import { LocalMaterializer } from './materializer.js';
import { LocalSyncService } from './syncService.js';
import { LocalRecovery } from './recovery.js';
import { LocalBindingService } from './bindingService.js';

export class LocalService {
  readonly repository: LocalRepository;
  readonly sync: LocalSyncService;
  readonly bindings: LocalBindingService;
  private readonly recovery: LocalRecovery;
  private readonly unwatch: () => void;
  private readonly pending = new Map<string, Promise<unknown>>();
  constructor(
    private readonly deps: {
      db: Database;
      logger: DiagnosticLogger;
      broker: DeviceBroker;
      devices: DeviceService;
      connections: ConnectionService;
      skills: SkillService;
      changed: () => Promise<void>;
    },
  ) {
    this.repository = new LocalRepository(deps.db);
    const materializer = new LocalMaterializer({ ...deps, repository: this.repository });
    this.sync = new LocalSyncService({ ...deps, repository: this.repository, materializer });
    this.bindings = new LocalBindingService({
      repository: this.repository,
      sync: this.sync,
      materializer,
    });
    this.recovery = new LocalRecovery({ repository: this.repository, bindings: this.bindings });
    this.unwatch = deps.broker.watchLocal((id) => {
      void this.automatic(id).catch(() => this.deps.logger.report('LOCAL_SYNC_FAILED'));
    });
  }
  async close() {
    this.unwatch();
    await Promise.allSettled(this.pending.values());
  }
  serial<T>(id: string, work: () => Promise<T>): Promise<T> {
    const before = this.pending.get(id) ?? Promise.resolve();
    const current = before
      .catch(() => undefined)
      .then(() => this.repository.withDeviceLock(id, work));
    this.pending.set(id, current);
    void current
      .finally(() => {
        if (this.pending.get(id) === current) this.pending.delete(id);
      })
      .catch(() => undefined);
    return current;
  }
  async assert(ownerId: string, deviceId: string) {
    await this.deps.devices.owned(ownerId, deviceId);
    if (!this.deps.broker.online(deviceId))
      throw new AppError('DEVICE_OFFLINE', '设备离线，修改将在重连后核对', 503);
    this.deps.broker.requireCapability(deviceId, 'local-management');
  }
  private async automatic(id: string) {
    const [device] = await this.deps.db
      .select()
      .from(devices)
      .where(and(eq(devices.id, id), eq(devices.revoked, false)));
    if (!device) return;
    return this.serial(id, async () => {
      await this.recovery.mutations(device.ownerId, id);
      await this.sync.reconcile(device.ownerId, id);
      await this.recovery.completed(device.ownerId, id, await this.sync.state(id));
    });
  }
  async state(ownerId: string, deviceId: string) {
    await this.deps.devices.owned(ownerId, deviceId);
    const rows = await this.repository.list(ownerId, deviceId);
    let state: LocalState;
    if (this.deps.broker.online(deviceId)) {
      this.deps.broker.requireCapability(deviceId, 'local-management');
      state = await this.sync.state(deviceId);
    } else {
      const sources = await this.deps.db
        .select()
        .from(localSources)
        .where(and(eq(localSources.ownerId, ownerId), eq(localSources.deviceId, deviceId)));
      state = {
        revision: 1,
        identityResources: {},
        sources: sources.map((s) => s.metadata),
        resources: Object.fromEntries(
          rows.map((r) => [r.resourceId, { ...r.metadata, content: r.baseline }]),
        ),
        operations: {},
        issues: ['设备离线；此处为上次同步副本，重连后核对修改'],
      };
    }
    const authorized = await this.repository.authorizationSummary(ownerId, rows);
    return {
      ...state,
      bindings: rows.map((row) => ({
        ...row,
        authorizedProfiles: authorized.get(row.id) ?? [],
        localContent: state.resources[row.resourceId]?.content,
      })),
      platformOperations: await this.repository.operations(ownerId, deviceId),
    };
  }
  async request(ownerId: string, deviceId: string, raw: unknown) {
    await this.assert(ownerId, deviceId);
    const input = localRequest.parse(raw);
    if (input.action === 'state') return this.state(ownerId, deviceId);
    const result = await this.deps.broker.request(deviceId, {
      method: 'local.request',
      params: input as Record<string, unknown>,
    });
    if (!['resource', 'operation', 'backup', 'scan', 'start', 'stop'].includes(input.action))
      await this.serial(deviceId, () => this.sync.reconcile(ownerId, deviceId));
    return result;
  }
  online(deviceId: string) {
    return this.deps.broker.online(deviceId);
  }
  async startSync(ownerId: string, deviceId: string, key: string) {
    await this.assert(ownerId, deviceId);
    const op = await this.repository.operation(ownerId, {
      deviceId,
      key,
      action: 'reconcile',
      payload: {},
    });
    if (op.phase === 'succeeded') return op;
    void this.serial(deviceId, async () => {
      try {
        await this.repository.finish(op.id, { phase: 'running' });
        await this.sync.reconcile(ownerId, deviceId);
        await this.repository.finish(op.id, { phase: 'succeeded', result: { reconciled: true } });
      } catch (error) {
        await this.repository.finish(op.id, { phase: 'failed', error: errorMessage(error) });
      }
    }).catch(async (error: unknown) => {
      await this.repository.finish(op.id, { phase: 'failed', error: errorMessage(error) });
      this.deps.logger.report('LOCAL_SYNC_OPERATION_FAILED');
    });
    return op;
  }
  async mutateBinding(ownerId: string, input: LocalBindingMutation) {
    localBindingMutation.parse(input);
    await this.deps.devices.owned(ownerId, input.deviceId);
    return this.serial(input.deviceId, async () => {
      const row = await this.repository.owned(ownerId, input);
      this.bindings.validate(row, input.content);
      const op = await this.repository.operation(ownerId, {
        deviceId: input.deviceId,
        key: input.operationId,
        action: input.action,
        payload: input,
      });
      if (op.phase === 'succeeded') return op.result;
      try {
        if (row.revision !== input.revision)
          throw new AppError('REVISION_CONFLICT', '同步副本已变化', 409);
        const result = await this.bindings.mutate(row, input, op.id);
        return result;
      } catch (error) {
        await this.repository.finish(op.id, { phase: 'failed', error: errorMessage(error) });
        throw error;
      }
    });
  }
}
