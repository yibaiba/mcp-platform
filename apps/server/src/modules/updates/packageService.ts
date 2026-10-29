import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { updateChecks, connections, type Database } from '@platform/db';
import { connectionInput, type ConnectionInput } from '@platform/contracts';
import { resolvePackage, publicSource, type PackageSpec } from '@platform/network';
import type { NetworkService } from '../network/service.js';
import type { DeviceService } from '../devices/deviceService.js';
import type { DeviceBroker } from '../devices/deviceBroker.js';
import { activeUser } from '../users/userAccess.js';
import { digest, type Vault } from '../../shared/crypto.js';
import { AppError } from '../../shared/errors.js';
import { latestStable, newerThanConfigured, queryPackage } from './packageVersions.js';
export const UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const deviceResult = z.object({
  package: z.object({
    ecosystem: z.enum(['npm', 'pypi']),
    name: z.string(),
    configured: z.string(),
    source: z.string(),
  }),
  versions: z.array(z.string()),
  networkRevision: z.number().int(),
  resourceDigest: z.string().optional(),
});
export class PackageUpdateService {
  private readonly pending = new Map<string, Promise<unknown>>();
  constructor(
    private readonly deps: {
      db: Database;
      vault: Vault;
      network: NetworkService;
      devices: DeviceService;
      broker: DeviceBroker;
      now: () => Date;
    },
  ) {}
  private async context(ownerId: string, id: string) {
    await activeUser(this.deps.db, ownerId);
    const [row] = await this.deps.db
      .select()
      .from(connections)
      .where(and(eq(connections.id, id), eq(connections.ownerId, ownerId)));
    if (!row) throw new AppError('NOT_FOUND', '只有连接所有者可以检查包更新', 404);
    const config = connectionInput.parse(this.deps.vault.open(row.config, `${ownerId}:${id}`));
    const network =
      config.adapter === 'device'
        ? this.deps.broker.generation(config.deviceId!)
        : (await this.deps.network.snapshot()).revision;
    return {
      row,
      config,
      fingerprint: digest(JSON.stringify([ownerId, id, row.revision, row.config, network])),
    };
  }
  private key(ownerId: string, id: string) {
    return `package:${ownerId}:${id}`;
  }
  async status(ownerId: string, id: string) {
    const context = await this.context(ownerId, id);
    const [saved] = await this.deps.db
      .select()
      .from(updateChecks)
      .where(eq(updateChecks.id, this.key(ownerId, id)));
    const stale = Boolean(saved && saved.fingerprint !== context.fingerprint);
    return {
      scheduled: saved?.scheduled ?? false,
      nextCheckAt: saved?.nextCheckAt,
      result: saved?.result ?? null,
      stale,
      runtimeVersion: null,
      runtimeVersionReason: '没有可验证的运行包版本证据；配置版本、缓存和 MCP 自报版本均不作为证明',
    };
  }
  async schedule(ownerId: string, id: string, value: unknown) {
    const { scheduled } = z.object({ scheduled: z.boolean() }).strict().parse(value);
    const { fingerprint } = await this.context(ownerId, id);
    const nextCheckAt = scheduled ? new Date(this.deps.now().getTime() + UPDATE_INTERVAL_MS) : null;
    await this.deps.db
      .insert(updateChecks)
      .values({
        id: this.key(ownerId, id),
        ownerId,
        connectionId: id,
        fingerprint,
        scheduled,
        nextCheckAt,
      })
      .onConflictDoUpdate({ target: updateChecks.id, set: { scheduled, nextCheckAt } });
    return this.status(ownerId, id);
  }
  async check(ownerId: string, id: string) {
    const context = await this.context(ownerId, id);
    const key = `${this.key(ownerId, id)}:${context.fingerprint}`;
    const existing = this.pending.get(key);
    if (existing) return existing;
    const pending = this.perform({ ownerId, id, context }).finally(() => this.pending.delete(key));
    this.pending.set(key, pending);
    return pending;
  }
  private async inspect(ownerId: string, config: ConnectionInput) {
    if (config.source !== 'mcp' || (!config.command && !config.deviceResourceId))
      throw new Error('此连接没有可识别的托管 npm/Python 包');
    if (config.adapter === 'device') {
      const device = await this.deps.devices.owned(ownerId, config.deviceId!);
      if (device.revoked) throw new Error('设备授权已撤销');
      if (!this.deps.broker.online(config.deviceId!)) throw new Error('设备离线，未执行包检查');
      this.deps.broker.requireCapability(config.deviceId!, 'package-updates');
      const result = deviceResult.parse(
        await this.deps.broker.request(config.deviceId!, {
          method: 'package.check',
          params: { config: { ...config, localIdentity: 'default' } },
          executionTimeoutMs: 20_000,
        }),
      );
      return {
        spec: result.package,
        versions: result.versions,
        deviceNetworkRevision: result.networkRevision,
      };
    }
    const settings = await this.deps.network.snapshot();
    const spec = resolvePackage(config, settings.config);
    if (!spec)
      throw new Error(
        '无法识别唯一的静态包声明；请使用明确的 npx、npm exec、uvx 或 uv tool run 参数',
      );
    return { spec, versions: await queryPackage(spec, this.deps.network.fetch) };
  }
  private async perform(input: {
    ownerId: string;
    id: string;
    context: Awaited<ReturnType<PackageUpdateService['context']>>;
  }) {
    const { ownerId, id, context } = input;
    const key = this.key(ownerId, id);
    const [previous] = await this.deps.db
      .select()
      .from(updateChecks)
      .where(eq(updateChecks.id, key));
    let result: Record<string, unknown>;
    try {
      const { spec, versions, ...extra } = await this.inspect(ownerId, context.config);
      const latest = latestStable(spec.ecosystem, versions);
      result = {
        state: 'checked',
        package: { ...spec, source: publicSource(spec.source) },
        latest,
        updateAvailable: newerThanConfigured(spec as PackageSpec, latest),
        checkedAt: this.deps.now().toISOString(),
        runtimeVersion: null,
        ...extra,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : '包更新检查失败';
      // Source URLs and credentials never enter persisted error messages.
      const safe = message
        .replace(/https?:\/\/\S+/g, '[来源地址]')
        .replace(/(?:Bearer|Basic)\s+\S+/gi, '[凭证]');
      result = {
        state: 'failed',
        error: safe,
        checkedAt: this.deps.now().toISOString(),
        lastSuccess:
          previous?.result?.state === 'checked'
            ? { ...previous.result, stale: true }
            : previous?.result?.lastSuccess,
      };
    }
    const current = await this.context(ownerId, id);
    if (current.fingerprint !== context.fingerprint)
      throw new AppError('CHECK_SUPERSEDED', '连接或网络配置已变化，请重新检查', 409);
    await this.deps.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(connections)
        .where(and(eq(connections.id, id), eq(connections.ownerId, ownerId)))
        .for('share');
      if (!row || row.revision !== context.row.revision)
        throw new AppError('CHECK_SUPERSEDED', '连接配置已变化', 409);
      await this.deps.db
        .insert(updateChecks)
        .values({ id: key, ownerId, connectionId: id, fingerprint: context.fingerprint, result })
        .onConflictDoUpdate({
          target: updateChecks.id,
          set: { fingerprint: context.fingerprint, result },
        });
    });
    return this.status(ownerId, id);
  }
}
