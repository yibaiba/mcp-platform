import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { connections, profiles, catalogSnapshots, type Database } from '@platform/db';
import { connectionInput, type ConnectionInput } from '@platform/contracts';
import type { McpNotification } from '@platform/mcp';
import { digest, type Vault } from '../../shared/crypto.js';
import { AppError, requireValue } from '../../shared/errors.js';
import { redactConnectionError } from './connectionDiagnostics.js';
import type { DeviceService } from '../devices/deviceService.js';
import type { AdapterFactory, ConnectionContext } from './adapter.js';
import { ConnectionRuntime } from './connectionRuntime.js';
import { SessionLifecycle } from './lifecycle/sessionLifecycle.js';
import { BindingService } from '../authorizations/bindingService.js';
import { currentExecution, sessionScope, PLATFORM_CAPABILITIES } from './executionContext.js';
import { CatalogRepository, toolId } from './catalogRepository.js';
import { compileDocument } from '../openapi/compile.js';
import type { ApiDocument } from '../openapi/types.js';
import { validateOpenApiDocument } from '../openapi/importService.js';
export type ConnectionEvent = {
  ownerId: string;
  connectionId: string;
  notification: McpNotification;
  sessionId?: string;
  identity?: string;
};
export { toolId } from './catalogRepository.js';
export class ConnectionService {
  private readonly lifecycle: SessionLifecycle;
  private readonly catalogs: CatalogRepository;
  readonly bindings: BindingService;
  private readonly runtime: ConnectionRuntime;
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
      vault: Vault;
      factory: AdapterFactory;
      devices: DeviceService;
      publicUrl: string;
    },
  ) {
    this.bindings = new BindingService(deps);
    this.catalogs = new CatalogRepository(deps.db, this.bindings);
    this.lifecycle = new SessionLifecycle({
      sleep: async (context) => {
        await this.runtime.invalidate(context.runtimeKey!).closed;
      },
      error: async (context, error) => {
        if ((await this.owned(context.ownerId, context.id)).status === 'stopped') return;
        await deps.db
          .update(connections)
          .set({ status: 'error', error: this.redact(error, context.config) })
          .where(eq(connections.id, context.id));
      },
      recover: async (context) => {
        if ((await this.owned(context.ownerId, context.id)).status === 'stopped')
          throw new AppError('CONNECTION_STOPPED', '手动停止的连接不能自动恢复', 409);
        return deps.factory(context);
      },
    });
    this.runtime = new ConnectionRuntime(async (context, slot) => {
      await this.bindings.assertCredentials(context);
      const adapter = this.lifecycle.wrap(context, await deps.factory(context));
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
        const message = this.redact(error, context.config);
        console.error('MCP notification failed', context.id, message);
        await this.deps.db
          .update(connections)
          .set({ error: `通知处理失败：${message}` })
          .where(eq(connections.id, context.id));
      });
    this.notifications.set(context.id, pending);
    const cleanup = () => {
      if (this.notifications.get(context.id) === pending) this.notifications.delete(context.id);
    };
    void pending.then(cleanup, (error: unknown) => {
      cleanup();
      console.error(
        'MCP notification diagnostic persistence failed',
        context.id,
        error instanceof Error ? error.message : String(error),
      );
    });
  }
  async validate(ownerId: string, input: unknown) {
    const config = connectionInput.parse(input);
    if (config.source === 'openapi' && config.openapi) {
      if (config.health.enabled)
        throw new AppError('CHECK_UNSUPPORTED', 'OpenAPI 来源不提供 MCP 健康检查，请关闭该选项');
      await validateOpenApiDocument(config.openapi.document);
      const published = compileDocument(config.openapi.document as ApiDocument).filter((op) =>
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
  async createMany(ownerId: string, inputs: unknown[]) {
    const configs = await Promise.all(inputs.map((input) => this.validate(ownerId, input)));
    if (!configs.length) return [];
    const rows = configs.map((config) => {
      const id = randomUUID();
      return {
        id,
        ownerId,
        name: config.name,
        adapter: config.adapter,
        deviceId: config.deviceId,
        config: this.deps.vault.seal(config, `${ownerId}:${id}`),
      };
    });
    return this.deps.db.insert(connections).values(rows).returning({ id: connections.id });
  }

  async owned(ownerId: string, id: string) {
    const [row] = await this.deps.db
      .select()
      .from(connections)
      .where(and(eq(connections.id, id), eq(connections.ownerId, ownerId)));
    return requireValue(row);
  }
  async context(ownerId: string, id: string): Promise<ConnectionContext> {
    const row = await this.owned(ownerId, id);
    const config = connectionInput.parse(
      this.deps.vault.open<ConnectionInput>(row.config, `${ownerId}:${id}`),
    );
    const caller = currentExecution();
    const [profile] = caller?.profileId
      ? await this.deps.db
          .select()
          .from(profiles)
          .where(and(eq(profiles.id, caller.profileId), eq(profiles.ownerId, ownerId)))
      : [];
    if (caller?.profileId && !profile)
      throw new AppError('ACCESS_CONTEXT', 'Agent 不属于当前账号', 403);
    const scope = sessionScope(config, profile?.connectionIdentities[id]);
    const binding = await this.bindings.resolve({
      ownerId,
      connectionId: id,
      identity: scope.identity,
    });
    const scopedConfig = await this.bindings.configuration(
      binding,
      config,
      profile?.connectionIdentities[id] === 'profile' ||
        profile?.connectionIdentities[id] === 'credential',
    );
    return {
      id,
      ownerId,
      bindingId: binding.id,
      identity: scope.identity,
      sessionId: scope.session,
      capabilityKey: scope.capabilityKey,
      runtimeKey: `${id}:${binding.id}:${scope.capabilityKey}:${digest(scope.session)}:${scope.headerKey}`,
      capabilities: currentExecution()?.capabilities ?? PLATFORM_CAPABILITIES,
      correlationId: currentExecution()?.correlationId,
      profileId: caller?.profileId,
      config: { ...scopedConfig, headers: { ...scopedConfig.headers, ...scope.headers } },
    };
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
          transport: value.transport,
          source: value.source ?? 'mcp',
          identityMode: value.identityMode ?? 'shared',
          lifecycle: value.lifecycle,
          health: value.health,
          forwardHeaders: value.forwardHeaders ?? [],
          sessions: this.runtime.keys(row.id),
          mode: value.mode,
          url: value.url ? new URL(value.url).origin + new URL(value.url).pathname : undefined,
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
  async adapter(ownerId: string, id: string) {
    const context = await this.context(ownerId, id);
    if (context.config.deviceId) await this.deps.devices.owned(ownerId, context.config.deviceId);
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
    if (context.config.deviceId) await this.deps.devices.owned(ownerId, context.config.deviceId);
    const slot = this.runtime.acquire(context);
    try {
      const adapter = await this.runtime.adapter(slot);
      const combined = AbortSignal.any([slot.abort.signal, ...(signal ? [signal] : [])]);
      combined.throwIfAborted();
      const catalog = await adapter.catalog(combined);
      const discovered = catalog.tools;
      const saved = await this.runtime.write(slot, () => this.catalogs.save(context, catalog));
      if (!saved)
        throw new AppError('CONNECTION_SUPERSEDED', '连接已停止或被替换，旧发现结果未保存', 409);
      return discovered.map((tool) => ({ ...tool, id: toolId(id, tool.name) }));
    } catch (error) {
      if (signal?.aborted)
        throw new AppError('DISCOVERY_CANCELLED', this.redact(error, context.config), 409);
      if (!this.runtime.current(slot))
        throw new AppError('CONNECTION_SUPERSEDED', '连接已停止或被替换，旧发现请求已结束', 409);
      const { next, closed } = this.runtime.invalidate(slot.id);
      const message = this.redact(error, context.config);
      await this.runtime.write(next, () =>
        this.deps.db
          .update(connections)
          .set({ status: 'error', error: message })
          .where(eq(connections.id, id)),
      );
      try {
        await closed;
      } catch (closeError) {
        throw new AppError(
          'CONNECTION_FAILED',
          `${message}; 清理连接失败：${this.redact(closeError, context.config)}`,
          502,
        );
      }
      throw new AppError('CONNECTION_FAILED', message, 502);
    }
  }
  async snapshot(ownerId: string, id: string) {
    return this.bindings.snapshot(await this.context(ownerId, id));
  }
  async catalogForAccess(ownerId: string, id: string) {
    const context = await this.context(ownerId, id);
    const snapshot = await this.bindings.snapshot(context);
    const row = await this.owned(ownerId, id);
    if (row.status === 'stopped') return snapshot;
    if (snapshot && (context.config.lifecycle.startup === 'on-demand' || row.status === 'sleeping'))
      return snapshot;
    if (snapshot && (await this.runtime.status(context.runtimeKey!)) === 'connected')
      return snapshot;
    await this.wake(ownerId, id);
    return this.bindings.snapshot(context);
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
    for (const key of this.runtime.keys(context.id))
      if (key.startsWith(`${context.id}:${context.bindingId}:`))
        await this.runtime.invalidate(key).closed;
  }
  async update(ownerId: string, id: string, input: unknown) {
    const row = await this.owned(ownerId, id);
    const old = this.deps.vault.open<ConnectionInput>(row.config, `${ownerId}:${id}`);
    if (!input || typeof input !== 'object' || Array.isArray(input))
      throw new AppError('VALIDATION', '连接更新必须是对象');
    const { revision, ...patch } = input as Record<string, unknown>;
    if (revision !== undefined && revision !== row.revision)
      throw new AppError('REVISION_CONFLICT', '连接配置已变化，请重新加载', 409);
    const config = await this.validate(ownerId, { ...old, ...patch });
    await this.close(ownerId, id);
    const updated = await this.deps.db
      .update(connections)
      .set({
        revision: row.revision + 1,
        name: config.name,
        adapter: config.adapter,
        deviceId: config.deviceId ?? null,
        config: this.deps.vault.seal(config, `${ownerId}:${id}`),
        status: 'disconnected',
        error: null,
      })
      .where(and(eq(connections.id, id), eq(connections.revision, row.revision)))
      .returning({ id: connections.id });
    if (!updated.length) throw new AppError('REVISION_CONFLICT', '连接配置已变化，请重新加载', 409);
    await this.deps.db.delete(catalogSnapshots).where(eq(catalogSnapshots.connectionId, id));
    return { id };
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
}
