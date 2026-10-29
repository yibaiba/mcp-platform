import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { and, eq } from 'drizzle-orm';
import { mcpbPackages, mcpbInstalls, type Database } from '@platform/db';
import { z } from 'zod';
import { compileBundle, mcpbManifest, type BundleEnvironment } from '@platform/contracts';
import type { ConnectionService } from '../mcp/connectionService.js';
import type { DeviceService } from '../devices/deviceService.js';
import type { DeviceBroker } from '../devices/deviceBroker.js';
import type { FileStore } from '../artifacts/fileStore.js';
import type { BundleDiskStore } from './diskStore.js';
import { digest } from '../../shared/crypto.js';
import { AppError, requireValue } from '../../shared/errors.js';
import { unpackBundle } from './archive.js';
const target = z
  .object({
    adapter: z.enum(['direct', 'pi', 'device']),
    deviceId: z.uuid().optional(),
    values: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();
const installInput = target.extend({
  operationId: z.uuid(),
  connectionId: z.uuid().optional(),
  revision: z.number().int().positive().optional(),
  previewDigest: z.string(),
});
export class BundleService {
  constructor(
    private readonly deps: {
      db: Database;
      files: FileStore;
      disk: BundleDiskStore;
      connections: ConnectionService;
      devices: DeviceService;
      broker: DeviceBroker;
    },
  ) {}
  async recover() {
    await this.deps.db
      .update(mcpbInstalls)
      .set({
        state: 'unknown',
        error: '平台重启；安装结果未知，请检查连接和目标目录，不会自动重放。',
      })
      .where(eq(mcpbInstalls.state, 'running'));
  }
  async upload(ownerId: string, body: ReadableStream<Uint8Array>) {
    const id = randomUUID();
    const saved = await this.deps.files.write({ id, body });
    try {
      const pkg = unpackBundle(
        new Uint8Array(await (await this.deps.files.blob(id)).arrayBuffer()),
      );
      const [row] = await this.deps.db
        .insert(mcpbPackages)
        .values({ id, ownerId, sha256: saved.sha256, manifest: pkg.manifest })
        .onConflictDoNothing()
        .returning();
      if (row) return this.publicPackage(row);
      await this.deps.files.remove(id);
      const [existing] = await this.deps.db
        .select()
        .from(mcpbPackages)
        .where(and(eq(mcpbPackages.ownerId, ownerId), eq(mcpbPackages.sha256, saved.sha256)));
      return this.publicPackage(requireValue(existing));
    } catch (error) {
      await this.deps.files.remove(id);
      throw error;
    }
  }
  private publicPackage(row: typeof mcpbPackages.$inferSelect) {
    const manifest = mcpbManifest.parse(row.manifest);
    for (const field of Object.values(manifest.user_config))
      if (field.sensitive) delete field.default;
    return { id: row.id, sha256: row.sha256, manifest };
  }
  private async owned(ownerId: string, id: string) {
    const [row] = await this.deps.db
      .select()
      .from(mcpbPackages)
      .where(and(eq(mcpbPackages.id, id), eq(mcpbPackages.ownerId, ownerId)));
    return requireValue(row);
  }
  private async environment(
    ownerId: string,
    input: z.infer<typeof target>,
    sha256: string,
  ): Promise<BundleEnvironment> {
    if (input.adapter !== 'device') {
      if (input.deviceId) throw new AppError('MCPB_TARGET', '平台执行不能选择设备');
      return {
        platform: z.enum(['darwin', 'linux', 'win32']).parse(process.platform),
        home: homedir(),
        root: this.deps.disk.directory(ownerId, sha256),
      };
    }
    if (!input.deviceId) throw new AppError('MCPB_TARGET', '请选择设备');
    await this.deps.devices.owned(ownerId, input.deviceId);
    if (!this.deps.broker.online(input.deviceId))
      throw new AppError('DEVICE_OFFLINE', '设备离线，未执行安装', 503);
    this.deps.broker.requireCapability(input.deviceId, 'mcpb');
    return z
      .object({
        platform: z.enum(['darwin', 'linux', 'win32']),
        home: z.string(),
        root: z.string(),
      })
      .parse(
        await this.deps.broker.request(input.deviceId, {
          method: 'mcpb.environment',
          params: { sha256 },
        }),
      );
  }
  async preview(ownerId: string, id: string, raw: unknown) {
    const input = target.parse(raw),
      row = await this.owned(ownerId, id);
    const environment = await this.environment(ownerId, input, row.sha256);
    const manifest = mcpbManifest.parse(row.manifest);
    const config = compile({ manifest, environment, values: input.values, redact: true });
    return {
      ...this.publicPackage(row),
      adapter: input.adapter,
      config,
      previewDigest: digest(JSON.stringify([row.sha256, input, environment])),
    };
  }
  async status(ownerId: string, id: string) {
    const [row] = await this.deps.db
      .select()
      .from(mcpbInstalls)
      .where(and(eq(mcpbInstalls.id, id), eq(mcpbInstalls.ownerId, ownerId)));
    return requireValue(row);
  }
  async install(ownerId: string, id: string, raw: unknown) {
    const input = installInput.parse(raw),
      row = await this.owned(ownerId, id);
    const { operationId, connectionId, revision, previewDigest, ...destination } = input;
    const fingerprint = digest(JSON.stringify([ownerId, id, input]));
    const [previous] = await this.deps.db
      .select()
      .from(mcpbInstalls)
      .where(and(eq(mcpbInstalls.id, operationId), eq(mcpbInstalls.ownerId, ownerId)));
    if (previous) {
      if (previous.fingerprint !== fingerprint)
        throw new AppError('MCPB_OPERATION_CONFLICT', '操作 ID 已用于其他安装', 409);
      return previous;
    }
    const environment = await this.environment(ownerId, destination, row.sha256);
    const expected = digest(JSON.stringify([row.sha256, destination, environment]));
    if (expected !== previewDigest)
      throw new AppError('MCPB_PREVIEW_CHANGED', '配置或执行位置已改变，请重新预览', 409);
    if (connectionId) {
      const connection = await this.deps.connections.owned(ownerId, connectionId);
      if (revision !== connection.revision)
        throw new AppError('REVISION_CONFLICT', '替换连接需要当前修订号', 409);
    }
    const [created] = await this.deps.db
      .insert(mcpbInstalls)
      .values({ id: operationId, ownerId, packageId: id, fingerprint, state: 'running' })
      .onConflictDoNothing()
      .returning();
    if (!created) {
      const previous = await this.status(ownerId, operationId);
      if (previous.fingerprint !== fingerprint)
        throw new AppError('MCPB_OPERATION_CONFLICT', '操作 ID 已用于其他安装', 409);
      return previous;
    }
    try {
      await this.perform(ownerId, { row, input, environment });
    } catch (error) {
      await this.deps.db
        .update(mcpbInstalls)
        .set({
          state: 'failed',
          error: '安装或连接失败；请检查连接诊断、设备和运行时。不会自动重试或回滚。',
        })
        .where(eq(mcpbInstalls.id, operationId));
      if (error instanceof AppError) throw error;
      throw new AppError(
        'MCPB_INSTALL_FAILED',
        '安装失败；请检查运行时与文件权限，不会自动重试或回滚',
        502,
      );
    }
    return this.status(ownerId, operationId);
  }
  private async perform(
    ownerId: string,
    data: {
      row: typeof mcpbPackages.$inferSelect;
      input: z.infer<typeof installInput>;
      environment: BundleEnvironment;
    },
  ) {
    const { row, input, environment } = data;
    const bytes = new Uint8Array(await (await this.deps.files.blob(row.id)).arrayBuffer());
    if (digest(Buffer.from(bytes)) !== row.sha256)
      throw new AppError('MCPB_DIGEST', '扩展包文件校验失败，未执行安装', 409);
    const pkg = unpackBundle(bytes);
    const launch = compile({ manifest: pkg.manifest, environment, values: input.values });
    if (input.adapter === 'device') {
      await this.deps.broker.request(input.deviceId!, {
        method: 'mcpb.install',
        params: {
          sha256: row.sha256,
          archive: Buffer.from(bytes).toString('base64'),
          operationId: input.operationId,
        },
      });
    } else await this.deps.disk.extract({ ownerId, sha256: row.sha256, ...pkg });
    const config = {
      name: pkg.manifest.display_name ?? pkg.manifest.name,
      adapter: input.adapter,
      deviceId: input.deviceId,
      source: 'mcp',
      transport: 'stdio',
      mode: 'managed',
      ...launch,
    };
    const connection = input.connectionId
      ? await this.deps.connections.replace(ownerId, input.connectionId, {
          ...config,
          revision: input.revision,
        })
      : await this.deps.connections.create(ownerId, config);
    await this.deps.db
      .update(mcpbInstalls)
      .set({ connectionId: connection.id })
      .where(eq(mcpbInstalls.id, input.operationId));
    await this.deps.connections.discover(ownerId, connection.id);
    await this.deps.db
      .update(mcpbInstalls)
      .set({ state: 'succeeded' })
      .where(eq(mcpbInstalls.id, input.operationId));
  }
}

function compile(input: Parameters<typeof compileBundle>[0]) {
  try {
    return compileBundle(input);
  } catch (error) {
    throw new AppError('MCPB_CONFIGURATION', (error as Error).message);
  }
}
