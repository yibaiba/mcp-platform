import { indexLibrary, libraryConflict } from '../library/indexStore.js';
import type { DiagnosticLogger } from '../activity/systemLogger.js';
import { activeUser } from '../users/userAccess.js';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { connections, catalogSnapshots, type Database } from '@platform/db';
import {
  connectionInput,
  connectorPresets,
  maskArguments,
  matchesConnectorPreset,
  restoreHiddenArguments,
  type ConnectionInput,
} from '@platform/contracts';
import type { McpNotification } from '@platform/mcp';
import { type Vault } from '../../shared/crypto.js';
import { AppError, errorMessage, requireValue } from '../../shared/errors.js';
import { redactConnectionError } from './connectionDiagnostics.js';
import type { DeviceService } from '../devices/deviceService.js';
import type { AdapterFactory, ConnectionContext } from './adapter.js';
import { ConnectionRuntime } from './connectionRuntime.js';
import { SessionLifecycle } from './lifecycle/sessionLifecycle.js';
import { BindingService } from '../authorizations/bindingService.js';
import { connectionContext } from './connectionContext.js';
import type { ShareService } from '../shares/shareService.js';
import { CatalogRepository, toolId } from './catalogRepository.js';
import { compileDocument } from '../openapi/compile.js';
import type { ApiDocument } from '../openapi/types.js';
import { validateOpenApiDocument } from '../openapi/importService.js';
import { assertHostStdioAllowed, isHostStdio } from './hostStdio.js';
export type ConnectionEvent = {
  ownerId: string;
  connectionId: string;
  notification: McpNotification;
  sessionId?: string;
  identity?: string;
};
export { toolId } from './catalogRepository.js';
export type ConnectionUnavailable = { connectionId: string; code: string; message: string };
export class ConnectionService {
  private readonly lifecycle: SessionLifecycle;
  private readonly catalogs: CatalogRepository;
  readonly bindings: BindingService;
  private readonly runtime: ConnectionRuntime;
  private readonly catalogListeners = new Set<(ownerId: string) => void>();
  watchCatalog(listener: (ownerId: string) => void) {
    this.catalogListeners.add(listener);
    return () => this.catalogListeners.delete(listener);
  }
  private readonly listeners = new Set<(event: ConnectionEvent) => Promise<void>>();
  private readonly closingListeners = new Set<(context: ConnectionContext) => Promise<void>>();
  private readonly waking = new Map<
    string,
    Promise<Awaited<ReturnType<ConnectionService['discover']>>>
  >();
  private readonly notifications = new Map<string, Promise<void>>();
  constructor(
    private readonly deps: {
      db: Database;
      logger: DiagnosticLogger;
      vault: Vault;
      factory: AdapterFactory;
      devices: DeviceService;
      publicUrl: string;
      shares: ShareService;
      /** Read on every check so the deployment switch is authoritative for existing rows too. */
      hostStdio?: () => boolean;
    },
  ) {
    this.bindings = new BindingService(deps);
    this.catalogs = new CatalogRepository(deps.db, this.bindings);
    this.lifecycle = new SessionLifecycle({
      diagnostic: (code) => deps.logger.report(code),
      sleep: async (context) => {
        await this.runtime.invalidate(context.runtimeKey!).closed;
      },
      error: async (context, error) => {
        const row = await this.accessible(context.ownerId, context.id);
        if (row.status === 'stopped' || row.revision !== context.revision) return;
        if (context.shareId)
          return this.deps.shares.state(context, 'error', '共享连接暂不可用；请检查身份和运行位置');
        await deps.db
          .update(connections)
          .set({ status: 'error', error: this.redact(error, context.config) })
          .where(and(eq(connections.id, context.id), eq(connections.revision, row.revision)));
      },
      recover: async (context) => {
        const row = await this.accessible(context.ownerId, context.id);
        if (row.status === 'stopped')
          throw new AppError('CONNECTION_STOPPED', '手动停止的连接不能自动恢复', 409);
        if (row.revision !== context.revision)
          throw new AppError('CONNECTION_SUPERSEDED', '连接配置已更新，旧会话不再恢复', 409);
        await this.bindings.assertCredentials(context);
        return this.createAdapter(context);
      },
    });
    this.runtime = new ConnectionRuntime(async (context, slot) => {
      await this.bindings.assertCredentials(context);
      const adapter = this.lifecycle.wrap(
        context,
        await this.createAdapter(context),
        slot.abort.signal,
      );
      const current = () => this.runtime.current(slot) && !slot.abort.signal.aborted;
      const unwatch = adapter.watch((notification) =>
        this.receive({ context, notification, current }),
      );
      const close = adapter.close.bind(adapter);
      return {
        ...adapter,
        close: async () => {
          unwatch();
          try {
            for (const listener of this.closingListeners) await listener(context);
          } finally {
            await close();
          }
        },
      };
    });
  }
  watch(listener: (event: ConnectionEvent) => Promise<void>) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  watchClosing(listener: (context: ConnectionContext) => Promise<void>) {
    this.closingListeners.add(listener);
    return () => this.closingListeners.delete(listener);
  }
  private receive({
    context,
    notification,
    current,
  }: {
    context: ConnectionContext;
    notification: McpNotification;
    current: () => boolean;
  }) {
    const previous = this.notifications.get(context.id) ?? Promise.resolve();
    const pending = previous
      .then(async () => {
        if (!current()) return;
        if (notification.method.endsWith('/list_changed')) await this.discoverContext(context);
        if (!current()) return;
        for (const listener of this.listeners)
          await listener({
            ownerId: context.ownerId,
            connectionId: context.id,
            notification,
            sessionId: context.sessionId,
            identity: context.identity,
          });
      })
      .catch(async (error: unknown) => {
        if (!current()) return;
        if (context.shareId)
          return this.deps.shares.state(context, 'error', '共享连接目录通知失败');
        const message = this.redact(error, context.config);
        this.deps.logger.report('MCP_NOTIFICATION_FAILED', context.ownerId);
        await this.deps.db
          .update(connections)
          .set({ error: `通知处理失败：${message}` })
          .where(eq(connections.id, context.id));
      });
    this.notifications.set(context.id, pending);
    const cleanup = () => {
      if (this.notifications.get(context.id) === pending) this.notifications.delete(context.id);
    };
    void pending.then(cleanup, () => {
      cleanup();
      this.deps.logger.report('MCP_DIAGNOSTIC_PERSISTENCE_FAILED', context.ownerId);
    });
  }
  /** Marks stored platform-host stdio rows that are no longer allowed so they never spawn silently. */
  async enforceHostStdio() {
    const rows = await this.deps.db
      .select({
        id: connections.id,
        ownerId: connections.ownerId,
        adapter: connections.adapter,
        config: connections.config,
      })
      .from(connections)
      .where(inArray(connections.adapter, ['direct', 'pi']));
    let blocked = 0;
    for (const row of rows) {
      let config: ConnectionInput;
      try {
        config = this.deps.vault.open<ConnectionInput>(row.config, `${row.ownerId}:${row.id}`);
      } catch {
        // Unreadable rows cannot start either; createAdapter re-checks before any spawn.
        continue;
      }
      if (!isHostStdio({ adapter: row.adapter, transport: config.transport })) continue;
      try {
        await this.assertHostStdio(row.ownerId);
      } catch (error) {
        if (!(error instanceof AppError)) throw error;
        blocked += 1;
        await this.deps.db
          .update(connections)
          .set({ status: 'error', error: error.message })
          .where(eq(connections.id, row.id));
        this.deps.logger.report(`${error.code}_BLOCKED`, row.ownerId);
      }
    }
    return blocked;
  }
  /** Platform-host stdio is admin-only and requires PLATFORM_STDIO_ENABLED=true. */
  async assertHostStdio(ownerId: string) {
    await assertHostStdioAllowed(this.deps.db, this.deps.hostStdio?.() ?? false, ownerId);
  }
  async validate(ownerId: string, input: unknown) {
    let config = connectionInput.parse(input);
    if (isHostStdio(config)) await this.assertHostStdio(ownerId);
    if (config.deviceResourceId)
      await this.deps.devices.assertLocalReference(ownerId, {
        deviceId: config.deviceId!,
        resourceId: config.deviceResourceId,
      });

    if (config.source === 'openapi' && config.openapi) {
      if (config.health.enabled)
        throw new AppError('CHECK_UNSUPPORTED', 'OpenAPI 来源不提供 MCP 健康检查，请关闭该选项');
      const document = await validateOpenApiDocument(config.openapi.document);
      const published = compileDocument(document as ApiDocument).filter((op) =>
        config.openapi!.operations.includes(op.key),
      );
      if (
        published.length !== new Set(config.openapi.operations).size ||
        published.some((op) => op.unsupported.length)
      )
        throw new AppError(
          'OPENAPI_OPERATIONS',
          published
            .filter((op) => op.unsupported.length)
            .map((op) => `${op.key}: ${op.unsupported.join('; ')}`)
            .join('\n') || '发布的操作不存在',
        );
      // Keep standalone tool schemas independent of document-scoped references.
      config = {
        ...config,
        openapi: { ...config.openapi, document: document as unknown as Record<string, unknown> },
      };
    }
    if (config.deviceId) await this.deps.devices.owned(ownerId, config.deviceId);
    if (
      config.url &&
      new URL(config.url).origin === new URL(this.deps.publicUrl).origin &&
      new URL(config.url).pathname.startsWith('/mcp/')
    )
      throw new AppError('GATEWAY_LOOP', '上游地址不能指向本平台 MCP 入口');
    return config;
  }
  async create(ownerId: string, input: unknown) {
    return requireValue((await this.createMany(ownerId, [input]))[0]);
  }
  async createIdentified(ownerId: string, input: { id: string; config: unknown }) {
    const config = await this.validate(ownerId, input.config);
    await this.deps.db
      .transaction(async (tx) => {
        const inserted = await tx
          .insert(connections)
          .values({
            id: input.id,
            ownerId,
            name: config.name,
            toolPrefix: config.toolPrefix ?? null,
            adapter: config.adapter,
            deviceId: config.deviceId,
            config: this.deps.vault.seal(config, `${ownerId}:${input.id}`),
          })
          .onConflictDoNothing()
          .returning({ id: connections.id, revision: connections.revision });
        if (inserted.length) await indexLibrary(tx, { id: input.id, ownerId, config });
      })
      .catch(libraryConflict);
    return this.owned(ownerId, input.id);
  }
  async createMany(ownerId: string, inputs: unknown[]) {
    const configs = await Promise.all(inputs.map((input) => this.validate(ownerId, input)));
    if (!configs.length) return [];
    const rows = configs.map((config) => {
      const id = randomUUID();
      return {
        id,
        ownerId,
        name: config.name,
        toolPrefix: config.toolPrefix ?? null,
        adapter: config.adapter,
        deviceId: config.deviceId,
        config: this.deps.vault.seal(config, `${ownerId}:${id}`),
      };
    });
    return this.deps.db
      .transaction(async (tx) => {
        const inserted = await tx
          .insert(connections)
          .values(rows)
          .returning({ id: connections.id, revision: connections.revision });
        for (const [index, row] of rows.entries())
          await indexLibrary(tx, { id: row.id, ownerId, config: configs[index]! });
        return inserted;
      })
      .catch(libraryConflict);
  }

  async owned(ownerId: string, id: string) {
    const [row] = await this.deps.db
      .select()
      .from(connections)
      .where(and(eq(connections.id, id), eq(connections.ownerId, ownerId)));
    return requireValue(row);
  }
  context(ownerId: string, id: string): Promise<ConnectionContext> {
    return connectionContext({ ...this.deps, bindings: this.bindings }, { ownerId, id });
  }
  async accessible(ownerId: string, id: string) {
    return (await this.deps.shares.connection(ownerId, id)).connection;
  }
  private async createAdapter(context: ConnectionContext) {
    await activeUser(this.deps.db, context.ownerId);
    // Existing rows predate the switch: never spawn a host process unless still allowed.
    if (isHostStdio(context.config)) {
      const owner = context.resourceOwnerId ?? context.ownerId;
      try {
        await this.assertHostStdio(owner);
      } catch (error) {
        this.deps.logger.report(
          error instanceof AppError ? `${error.code}_BLOCKED` : 'HOST_STDIO_BLOCKED',
          owner,
        );
        throw error;
      }
    }
    await this.deps.shares.assertContext(context);
    await this.bindings.assertCredentials(context);
    const adapter = await this.deps.factory(context);
    try {
      await activeUser(this.deps.db, context.ownerId);
      await this.deps.shares.assertContext(context);
      return adapter;
    } catch (error) {
      await adapter.close();
      throw error;
    }
  }
  async closeShare(shareId: string) {
    for (const key of this.runtime.keysForShare(shareId)) await this.runtime.invalidate(key).closed;
  }
  async closeOwnerSessions(ownerId: string) {
    for (const key of this.runtime.keysForOwner(ownerId)) await this.runtime.invalidate(key).closed;
  }

  async list(ownerId: string) {
    const rows = await this.deps.db
      .select()
      .from(connections)
      .where(eq(connections.ownerId, ownerId));
    return Promise.all(
      rows.map(async ({ config, ...row }) => {
        const value = this.deps.vault.open<ConnectionInput>(config, `${ownerId}:${row.id}`);
        const status =
          row.status === 'connected'
            ? await this.runtime.status((await this.context(ownerId, row.id)).runtimeKey!)
            : row.status;
        return {
          ...row,
          status,
          // The connector, not the upstream, is what is down: tools cannot run until it is back.
          deviceOffline: Boolean(row.deviceId && !this.deps.devices.online(row.deviceId)),
          transport: value.transport,
          source: value.source ?? 'mcp',
          registry: value.registry,
          identityMode: value.identityMode ?? 'shared',
          lifecycle: value.lifecycle,
          health: value.health,
          connectTimeoutMs: value.connectTimeoutMs ?? 60_000,
          requestOptions: connectionInput.parse(value).requestOptions,
          recovery: this.lifecycle.recovery(row.id, ownerId),
          forwardHeaders: value.forwardHeaders ?? [],
          sessions: this.runtime.keys(row.id),
          mode: value.mode,
          presetId: connectorPresets.find((preset) => matchesConnectorPreset(value, preset))?.id,
          url: value.url ? new URL(value.url).origin + new URL(value.url).pathname : undefined,
          // The edit form needs these; the query string and sensitive args may hold secrets.
          urlHasQuery: Boolean(value.url && new URL(value.url).search),
          command: value.command,
          args: maskArguments(value.args ?? [], value.sensitiveArguments),
          cwd: value.cwd,
        };
      }),
    );
  }
  async lease(ownerId: string, id: string) {
    const context = await this.context(ownerId, id);
    await this.adapter(ownerId, id);
    const slot = this.runtime.acquire(context);
    return { signal: slot.abort.signal, release: this.lifecycle.hold(slot.id) };
  }
  recovery(ownerId: string, id: string) {
    return this.lifecycle.recovery(id, ownerId);
  }
  async adapter(ownerId: string, id: string) {
    const context = await this.context(ownerId, id);
    if (context.config.deviceId)
      await this.deps.devices.owned(
        context.credentialScope?.ownerId ?? ownerId,
        context.config.deviceId,
      );
    const slot = this.runtime.acquire(context);
    try {
      const adapter = await this.runtime.adapter(slot);
      if (!this.runtime.current(slot))
        throw new AppError('CONNECTION_SUPERSEDED', '连接已停止或被替换', 409);
      return adapter;
    } catch (error) {
      if (this.runtime.current(slot)) await this.runtime.invalidate(slot.id).closed;
      throw error;
    }
  }
  async discover(ownerId: string, id: string, signal?: AbortSignal) {
    return this.discoverContext(await this.context(ownerId, id), signal);
  }
  private async discoverContext(context: ConnectionContext, signal?: AbortSignal) {
    const { ownerId, id } = context;
    if (context.config.deviceId)
      await this.deps.devices.owned(
        context.credentialScope?.ownerId ?? ownerId,
        context.config.deviceId,
      );
    const slot = this.runtime.acquire(context);
    try {
      const adapter = await this.runtime.adapter(slot);
      const combined = AbortSignal.any([slot.abort.signal, ...(signal ? [signal] : [])]);
      combined.throwIfAborted();
      const catalog = await adapter.catalog(combined);
      await this.deps.shares.assertContext(context);
      const grant = context.shareId
        ? (await this.deps.shares.connection(ownerId, id)).share
        : undefined;
      const discovered = grant
        ? catalog.tools.filter((tool) => grant.toolIds.includes(toolId(id, tool.name)))
        : catalog.tools;
      const saved = await this.runtime.write(slot, () => this.catalogs.save(context, catalog));
      if (!saved)
        throw new AppError('CONNECTION_SUPERSEDED', '连接已停止或被替换，旧发现结果未保存', 409);
      for (const listener of this.catalogListeners) listener(ownerId);
      return discovered.map((tool) => ({ ...tool, id: toolId(id, tool.name) }));
    } catch (error) {
      if (signal?.aborted)
        throw new AppError('DISCOVERY_CANCELLED', this.redact(error, context.config), 409);
      if (!this.runtime.current(slot))
        throw new AppError('CONNECTION_SUPERSEDED', '连接已停止或被替换，旧发现请求已结束', 409);
      const { next, closed } =
        context.config.health.recover && this.lifecycle.recovery(id).length
          ? { next: slot, closed: Promise.resolve() }
          : this.runtime.invalidate(slot.id);
      // An offline connector is not an upstream failure: say which device and what to do.
      const offline = error instanceof AppError && error.code === 'DEVICE_OFFLINE';
      const message =
        context.shareId && context.credentialScope?.ownerId !== ownerId
          ? '共享上游不可用，请联系连接所有者检查授权或设备'
          : offline
            ? (await this.unavailable(ownerId, id)).message
            : this.redact(error, context.config);
      await this.runtime.write(next, () =>
        context.shareId
          ? this.deps.shares.state(context, 'error', message)
          : this.deps.db
              .update(connections)
              .set({ status: 'error', error: message })
              .where(eq(connections.id, id)),
      );
      try {
        await closed;
      } catch (closeError) {
        throw new AppError(
          'CONNECTION_FAILED',
          `${message}; 清理连接失败：${context.shareId && context.credentialScope?.ownerId !== ownerId ? '请联系连接所有者' : this.redact(closeError, context.config)}`,
          502,
        );
      }
      // Policy rejections keep their 403 code instead of looking like an upstream failure.
      if (error instanceof AppError && error.code.startsWith('HOST_STDIO_')) throw error;
      if (offline) throw new AppError('DEVICE_OFFLINE', message, 503);
      throw new AppError('CONNECTION_FAILED', message, 502);
    }
  }
  async snapshot(ownerId: string, id: string) {
    return this.bindings.snapshot(await this.context(ownerId, id));
  }
  async searchMetadata(ownerId: string, id: string) {
    const context = await this.context(ownerId, id);
    let metadata = await this.bindings.searchMetadata(context);
    if (!metadata) {
      await this.catalogForSearch(ownerId, id);
      metadata = await this.bindings.searchMetadata(context);
    }
    return { context, metadata };
  }
  async catalogForSearch(ownerId: string, id: string) {
    const context = await this.context(ownerId, id);
    const snapshot = await this.bindings.snapshot(context);
    if (snapshot) return snapshot;
    const active = this.runtime.keysForOwner(ownerId).filter((key) => key.startsWith(`${id}:`));
    const statuses = await Promise.all(active.map((key) => this.runtime.status(key)));
    if (!statuses.includes('connected'))
      throw new AppError(
        'SEARCH_CATALOG_PENDING',
        '当前身份尚无目录缓存；请先连接并完成授权，搜索不会唤醒连接',
        409,
      );
    await this.discoverContext(context);
    return this.bindings.snapshot(context);
  }
  async catalogForAccess(ownerId: string, id: string) {
    const context = await this.context(ownerId, id);
    const snapshot = await this.bindings.snapshot(context);
    const row = await this.accessible(ownerId, id);
    if (row.status === 'stopped') return snapshot;
    if (snapshot && (context.config.lifecycle.startup === 'on-demand' || row.status === 'sleeping'))
      return snapshot;
    if (snapshot && (await this.runtime.status(context.runtimeKey!)) === 'connected')
      return snapshot;
    await this.wake(ownerId, id);
    return this.bindings.snapshot(context);
  }
  /**
   * Catalog for one connection that never fails the caller: a broken upstream or offline device
   * falls back to the cached snapshot and reports why, so one connection cannot take down an Agent.
   */
  async catalogOrUnavailable(ownerId: string, id: string) {
    const row = await this.accessible(ownerId, id);
    // An offline connector cannot answer; do not spend a wake attempt finding that out.
    if (row.status !== 'stopped' && row.deviceId && !this.deps.devices.online(row.deviceId))
      return {
        snapshot: await this.snapshot(ownerId, id).catch(() => undefined),
        unavailable: await this.unavailable(ownerId, id),
      };
    try {
      const snapshot = await this.catalogForAccess(ownerId, id);
      // Another identity's runtime may have just failed while this one still looks connected:
      // confirm against the upstream once, so every page agrees with the connection status.
      if (row.status === 'error') await this.discover(ownerId, id);
      return { snapshot: row.status === 'error' ? await this.snapshot(ownerId, id) : snapshot };
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      const unavailable = await this.unavailable(ownerId, id, error);
      this.deps.logger.report(`CATALOG_DEGRADED_${unavailable.code}`, ownerId);
      const snapshot = await this.snapshot(ownerId, id).catch(() => undefined);
      return { snapshot, unavailable };
    }
  }
  /** Readable reason and next step for a connection whose tools cannot run right now. */
  async unavailable(ownerId: string, id: string, error?: AppError): Promise<ConnectionUnavailable> {
    const row = await this.accessible(ownerId, id).catch(() => undefined);
    const name = row?.name ?? id;
    const deviceId = row?.deviceId;
    if (deviceId && !this.deps.devices.online(deviceId)) {
      const device = await this.deps.devices.owned(ownerId, deviceId).catch(() => undefined);
      return {
        connectionId: id,
        code: 'DEVICE_OFFLINE',
        message: `「${name}」所在设备${device ? `「${device.name}」` : ''}离线：在那台电脑重新运行安装命令，连接器上线后工具自动恢复`,
      };
    }
    const reason = error?.message ?? row?.error ?? '连接不可用';
    return {
      connectionId: id,
      code: error?.code ?? 'CONNECTION_FAILED',
      message: `「${name}」暂不可用：${reason}。到「连接」页检查配置后点「重试」`,
    };
  }
  redact(error: unknown, config: ConnectionInput) {
    return redactConnectionError(error, config);
  }
  async close(ownerId: string, id: string) {
    await this.owned(ownerId, id);
    for (const key of this.runtime.keys(id)) await this.runtime.invalidate(key).closed;
  }
  async closeProfile(profileId: string) {
    for (const key of this.runtime.keysForProfile(profileId))
      await this.runtime.invalidate(key).closed;
  }
  sessions(ownerId: string, filter: { profileId?: string; bindingId?: string }) {
    return this.runtime
      .sessions(ownerId)
      .filter(
        (session) =>
          (!filter.profileId || session.profileId === filter.profileId) &&
          (!filter.bindingId || session.bindingId === filter.bindingId),
      );
  }
  async closeBinding(context: ConnectionContext) {
    for (const key of this.runtime.keysForCredentialBinding(context.bindingId!))
      await this.runtime.invalidate(key).closed;
    for (const key of this.runtime.keys(context.id))
      if (key.startsWith(`${context.id}:${context.bindingId}:`))
        await this.runtime.invalidate(key).closed;
  }
  update(ownerId: string, id: string, input: unknown) {
    return this.saveConfig({ ownerId, id, input, replace: false });
  }
  replace(ownerId: string, id: string, input: unknown) {
    return this.saveConfig({ ownerId, id, input, replace: true });
  }
  private async saveConfig({
    ownerId,
    id,
    input,
    replace,
  }: {
    ownerId: string;
    id: string;
    input: unknown;
    replace: boolean;
  }) {
    const row = await this.owned(ownerId, id);
    const old = this.deps.vault.open<ConnectionInput>(row.config, `${ownerId}:${id}`);
    if (!input || typeof input !== 'object' || Array.isArray(input))
      throw new AppError('VALIDATION', '连接更新必须是对象');
    const { revision, ...patch } = input as Record<string, unknown>;
    if (revision !== undefined && revision !== row.revision)
      throw new AppError('REVISION_CONFLICT', '连接配置已变化，请重新加载', 409);
    if (Array.isArray(patch.args))
      try {
        patch.args = restoreHiddenArguments(old, patch.args as string[]);
      } catch (error) {
        throw new AppError('VALIDATION', errorMessage(error));
      }
    const config = await this.validate(ownerId, replace ? patch : { ...old, ...patch });
    await this.close(ownerId, id);
    const updated = await this.deps.db
      .transaction(async (tx) => {
        const updated = await tx
          .update(connections)
          .set({
            revision: row.revision + 1,
            name: config.name,
            toolPrefix: config.toolPrefix ?? null,
            adapter: config.adapter,
            deviceId: config.deviceId ?? null,
            config: this.deps.vault.seal(config, `${ownerId}:${id}`),
            status: 'disconnected',
            error: null,
          })
          .where(and(eq(connections.id, id), eq(connections.revision, row.revision)))
          .returning({ id: connections.id, revision: connections.revision });
        if (updated.length) await indexLibrary(tx, { id, ownerId, config });
        return updated;
      })
      .catch(libraryConflict);
    if (!updated.length) throw new AppError('REVISION_CONFLICT', '连接配置已变化，请重新加载', 409);
    await this.deps.db.delete(catalogSnapshots).where(eq(catalogSnapshots.connectionId, id));
    return { id, revision: row.revision + 1 };
  }
  async wake(ownerId: string, id: string) {
    const context = await this.context(ownerId, id);
    const key = context.runtimeKey!;
    const previous = this.waking.get(key);
    if (previous) return previous;
    const waking = this.discoverContext(context);
    this.waking.set(key, waking);
    try {
      return await waking;
    } finally {
      if (this.waking.get(key) === waking) this.waking.delete(key);
    }
  }
  async sleep(ownerId: string, id: string) {
    await this.owned(ownerId, id);
    if (this.lifecycle.busy(id))
      throw new AppError('CONNECTION_BUSY', '连接有执行、交互或订阅租约，无法休眠', 409);
    await this.close(ownerId, id);
    await this.deps.db
      .update(connections)
      .set({ status: 'sleeping' })
      .where(eq(connections.id, id));
  }
  async check(ownerId: string, id: string) {
    if ((await this.owned(ownerId, id)).status === 'stopped')
      throw new AppError('CONNECTION_STOPPED', '连接已停止，请先唤醒', 409);
    const context = await this.context(ownerId, id);
    if (context.config.source === 'openapi')
      throw new AppError(
        'CHECK_UNSUPPORTED',
        'OpenAPI 来源不提供 MCP ping 或 server/discover 健康检查',
        409,
      );
    const adapter = await this.adapter(ownerId, id);
    if (!adapter.check)
      throw new AppError('CHECK_UNSUPPORTED', '连接器需要升级以支持健康检查', 409);
    await adapter.check(AbortSignal.timeout(context.config.health.timeoutMs));
    return { healthy: true, checkedAt: new Date().toISOString() };
  }
  async stop(ownerId: string, id: string) {
    await this.close(ownerId, id);
    await this.deps.db
      .update(connections)
      .set({ status: 'stopped', error: null })
      .where(eq(connections.id, id));
  }
  async shutdown() {
    await this.runtime.shutdown();
    await Promise.all(this.notifications.values());
  }
  async remove(ownerId: string, id: string) {
    await this.close(ownerId, id);
    await this.deps.db
      .delete(connections)
      .where(and(eq(connections.id, id), eq(connections.ownerId, ownerId)));
  }
}
