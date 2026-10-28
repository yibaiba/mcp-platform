import { activeUser } from '../users/userAccess.js';
import { and, eq } from 'drizzle-orm';
import { profiles, connections, type ManifestEntryState } from '@platform/db';
import { manifestApply } from '@platform/contracts';
import type { DiagnosticLogger } from '../activity/systemLogger.js';
import { withExecution, PLATFORM_CAPABILITIES } from '../mcp/executionContext.js';
import { AppError, requireValue } from '../../shared/errors.js';
import { ManifestStore, entryKey, declaredEntries, type StoredManifest } from './manifestStore.js';
import { ManifestReconciler, type ReconcilerDeps } from './reconciler.js';
import { DeploymentPending, validateDeclaration } from './values.js';

export class ManifestService {
  private readonly store: ManifestStore;
  private readonly reconciler: ManifestReconciler;
  private readonly jobs = new Map<string, Promise<unknown>>();
  private closed = false;
  constructor(private readonly deps: ReconcilerDeps & { logger: DiagnosticLogger }) {
    this.store = new ManifestStore(deps.db);
    this.reconciler = new ManifestReconciler(deps);
  }
  list(ownerId: string) {
    return this.store.list(ownerId);
  }
  async status(ownerId: string, name: string) {
    return requireValue(await this.store.find(ownerId, name));
  }
  async preview(ownerId: string, value: unknown) {
    const input = manifestApply.parse(value);
    validateDeclaration(input);
    const previous = await this.store.find(ownerId, input.declaration.name);
    const next = declaredEntries(input);
    const keys = new Set(next.map(entryKey));
    const conflicts = await this.store.conflicts(ownerId, previous?.entries ?? []);
    return {
      declaration: input.declaration,
      revision: previous?.revision,
      entries: next.map((entry) => ({
        kind: entry.kind,
        name: entry.name,
        action: previous?.entries.some((old) => entryKey(old) === entryKey(entry))
          ? 'upsert'
          : 'create',
        status: 'pending',
        reason: '应用后解析外部映射、秘密和真实能力目录',
      })),
      prune:
        input.mode === 'prune'
          ? (previous?.entries ?? [])
              .filter((entry) => entry.managed && !keys.has(entryKey(entry)))
              .map(entryKey)
          : [],
      conflicts,
    };
  }
  async apply(ownerId: string, value: unknown) {
    await activeUser(this.deps.db, ownerId);
    const input = manifestApply.parse(value);
    validateDeclaration(input);
    return this.enqueue(`${ownerId}:${input.declaration.name}`, () =>
      this.execution(ownerId, async () => {
        const manifest = await this.store.accept(ownerId, input);
        for (const entry of manifest.entries.filter(
          (entry) =>
            entry.kind === 'profile' && Object.hasOwn(manifest.declaration.profiles, entry.name),
        ))
          if (
            (await this.deps.profiles.owned(ownerId, entry.objectId!)).deploymentState !== 'ready'
          )
            await this.deps.changed(entry.objectId!);
        return this.reconcile(manifest);
      }),
    );
  }
  async refresh(ownerId: string) {
    const rows = await this.store.list(ownerId);
    return Promise.all(
      rows.map((row) =>
        this.enqueue(`${ownerId}:${row.name}`, () =>
          this.execution(ownerId, async () => this.reconcile(await this.status(ownerId, row.name))),
        ),
      ),
    );
  }
  private execution<T>(ownerId: string, action: () => Promise<T>) {
    return withExecution(
      {
        ownerId,
        identity: 'dashboard',
        entry: 'dashboard',
        sessionId: 'dashboard',
        capabilities: PLATFORM_CAPABILITIES,
      },
      action,
    );
  }
  async deviceReady(ownerId: string, deviceId: string) {
    const rows = await this.store.list(ownerId);
    for (const row of rows)
      for (const entry of row.entries) {
        if (entry.kind !== 'connection' || entry.status === 'ready' || !entry.objectId) continue;
        const declaration = row.declaration.connections[entry.name];
        if (
          declaration &&
          'config' in declaration &&
          declaration.deviceRef &&
          row.mappings.devices[declaration.deviceRef] === deviceId
        )
          await this.dependencyReady(ownerId, entry.objectId);
      }
  }
  async dependencyReady(ownerId: string, connectionId?: string) {
    const rows = await this.store.list(ownerId);
    const ids = new Set(
      rows.flatMap((row) =>
        row.entries
          .filter(
            (entry) =>
              entry.kind === 'connection' &&
              entry.revision &&
              (connectionId ? entry.objectId === connectionId : entry.status !== 'ready'),
          )
          .map((entry) => entry.objectId!),
      ),
    );
    for (const id of ids) {
      await this.execution(ownerId, async () => {
        const row = await this.deps.connections.accessible(ownerId, id);
        if (row.status === 'stopped') return;
        try {
          await this.deps.connections.discover(ownerId, id);
        } catch {
          this.deps.logger.report('MANIFEST_DISCOVERY_FAILED', ownerId);
        }
      });
    }
    return this.refresh(ownerId);
  }
  schedule(ownerId: string) {
    if (this.closed) return;
    void this.refresh(ownerId).catch(() =>
      this.deps.logger.report('MANIFEST_RECONCILIATION_FAILED', ownerId),
    );
  }
  private enqueue<T>(key: string, action: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new AppError('SHUTTING_DOWN', '配置服务正在关闭', 503));
    const previous = this.jobs.get(key);
    const job = previous ? previous.then(action, action) : action();
    this.jobs.set(key, job);
    const cleanup = () => {
      if (this.jobs.get(key) === job) this.jobs.delete(key);
    };
    void job.then(cleanup, cleanup);
    return job;
  }
  private async reconcile(manifest: StoredManifest) {
    let entries = [...manifest.entries];
    const checkpoint = async (next: ManifestEntryState) => {
      entries = entries.map((entry) => (entryKey(entry) === entryKey(next) ? next : entry));
      await this.store.checkpoint(manifest, entries);
    };
    for (const entry of entries) {
      if (!Object.hasOwn(manifest.declaration[`${entry.kind}s`], entry.name)) continue;
      try {
        await checkpoint(await this.reconciler.reconcile({ manifest, entry, entries, checkpoint }));
      } catch (error) {
        const latest = entries.find((row) => entryKey(row) === entryKey(entry))!;
        const pending =
          error instanceof DeploymentPending ||
          (error instanceof AppError &&
            ['SHARE_CONFIGURATION_PENDING', 'DEVICE_OFFLINE', 'OAUTH_REQUIRED'].includes(
              error.code,
            ));
        const reason =
          error instanceof DeploymentPending
            ? error.message
            : error instanceof AppError
              ? `${error.code}：请检查该条目的连接诊断或外部配置`
              : 'CONFIG_RESOLUTION_FAILED：配置解析失败，请查看系统日志';
        if (!(error instanceof AppError))
          this.deps.logger.report('MANIFEST_ENTRY_FAILED', manifest.ownerId);
        const status = pending ? 'pending' : 'error';
        await checkpoint({ ...latest, status, reason });
        if (entry.kind === 'profile') {
          await this.deps.db
            .update(profiles)
            .set({ deploymentState: status })
            .where(and(eq(profiles.id, entry.objectId!), eq(profiles.ownerId, manifest.ownerId)));
          await this.deps.changed(entry.objectId!);
        }
      }
    }
    if (manifest.mode === 'prune') entries = await this.prune(manifest, entries);
    return this.store.checkpoint(manifest, entries);
  }
  private async prune(manifest: StoredManifest, entries: ManifestEntryState[]) {
    const obsolete = entries.filter(
      (entry) => !Object.hasOwn(manifest.declaration[`${entry.kind}s`], entry.name),
    );
    const conflicts = await this.store.conflicts(manifest.ownerId, obsolete);
    if (conflicts.length)
      throw new AppError('MANIFEST_CONFLICT', `清理范围存在人工编辑：${conflicts.join(', ')}`, 409);
    let remaining = entries;
    for (const entry of obsolete.sort(
      (a, b) => Number(a.kind === 'connection') - Number(b.kind === 'connection'),
    )) {
      const next = remaining.filter((row) => entryKey(row) !== entryKey(entry));
      if (!entry.managed || !entry.objectId || entry.revision === undefined) {
        await this.store.checkpoint(manifest, next);
      } else if (entry.kind === 'share') {
        await this.deps.shares.revokeWithCheckpoint({
          ownerId: manifest.ownerId,
          id: entry.objectId,
          version: entry.revision,
          checkpoint: (tx) => this.store.checkpoint(manifest, next, tx),
        });
      } else {
        await this.pruneObject(manifest, { entry, next });
      }
      remaining = next;
    }
    return remaining;
  }
  private async pruneObject(
    manifest: StoredManifest,
    input: { entry: ManifestEntryState; next: ManifestEntryState[] },
  ) {
    const { entry, next } = input;
    const table = entry.kind === 'profile' ? profiles : connections;
    if (entry.kind === 'profile') await this.deps.changed(entry.objectId!);
    else await this.deps.connections.close(manifest.ownerId, entry.objectId!);
    await this.deps.db.transaction(async (tx) => {
      const removed = await tx
        .delete(table)
        .where(
          and(
            eq(table.id, entry.objectId!),
            eq(table.ownerId, manifest.ownerId),
            eq(table.revision, entry.revision!),
          ),
        )
        .returning({ id: table.id });
      if (!removed.length) throw new AppError('MANIFEST_CONFLICT', '清理前对象已被人工修改', 409);
      // The object mutation and manifest checkpoint commit together, so retrying
      // a failed prune never mistakes our own completed deletion for a manual edit.
      await this.store.checkpoint(manifest, next, tx);
    });
  }

  async close() {
    this.closed = true;
    const results = await Promise.allSettled([...this.jobs.values()]);
    const failures = results
      .filter((result) => result.status === 'rejected')
      .map((result) => result.reason);
    if (failures.length) throw new AggregateError(failures, 'Manifest 解析未成功完成');
  }
}
