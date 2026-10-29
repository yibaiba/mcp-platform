import { and, desc, eq } from 'drizzle-orm';
import {
  connections,
  mcpEntries,
  mcpbInstalls,
  mcpbPackages,
  tools,
  type Database,
} from '@platform/db';
import type { ConnectionInput } from '@platform/contracts';
import type { Vault } from '../../shared/crypto.js';
import type { ConnectionService } from '../mcp/connectionService.js';
import type { FileStore } from '../artifacts/fileStore.js';
import type { BundleDiskStore } from './diskStore.js';
import { AppError, requireValue } from '../../shared/errors.js';
import { removeConnectionReferences } from '../mcp/removeReferences.js';
export class BundleLifecycle {
  constructor(
    private readonly deps: {
      db: Database;
      files: FileStore;
      disk: BundleDiskStore;
      connections: ConnectionService;
      vault: Vault;
      changed: (ids: string[]) => Promise<void>;
    },
  ) {}
  async history(ownerId: string) {
    const operations = await this.deps.db
      .select({
        id: mcpbInstalls.id,
        packageId: mcpbInstalls.packageId,
        state: mcpbInstalls.state,
        phase: mcpbInstalls.phase,
        createdAt: mcpbInstalls.createdAt,
        connectionId: mcpbInstalls.connectionId,
        connectionRevision: mcpbInstalls.connectionRevision,
        destination: mcpbInstalls.destination,
        error: mcpbInstalls.error,
      })
      .from(mcpbInstalls)
      .where(eq(mcpbInstalls.ownerId, ownerId))
      .orderBy(desc(mcpbInstalls.createdAt));
    const packages = await this.deps.db
      .select({
        id: mcpbPackages.id,
        sha256: mcpbPackages.sha256,
        removedAt: mcpbPackages.removedAt,
        manifest: mcpbPackages.manifest,
      })
      .from(mcpbPackages)
      .where(eq(mcpbPackages.ownerId, ownerId));
    return {
      operations: operations.map((op) =>
        op.destination ? op : { ...op, createdAt: null, phase: 'legacy' },
      ),
      packages: packages.map((row) => ({
        id: row.id,
        sha256: row.sha256,
        removedAt: row.removedAt,
        name: row.manifest.display_name ?? row.manifest.name,
        version: row.manifest.version,
      })),
    };
  }
  async uninstall(ownerId: string, operationId: string) {
    const affected = await this.deps.db.transaction(async (tx) => {
      const [operation] = await tx
        .select()
        .from(mcpbInstalls)
        .where(and(eq(mcpbInstalls.id, operationId), eq(mcpbInstalls.ownerId, ownerId)))
        .for('update');
      const row = requireValue(operation);
      if (row.state === 'running')
        throw new AppError('MCPB_BUSY', '安装尚未结束，请刷新结果后再卸载', 409);
      if (!row.connectionId) return [];
      if (!row.connectionRevision)
        throw new AppError(
          'MCPB_UNINSTALL_UNVERIFIED',
          '旧安装记录缺少连接修订，请在连接管理中确认后删除',
          409,
        );
      const before = await this.deps.connections.owned(ownerId, row.connectionId);
      if (before.revision !== row.connectionRevision)
        throw new AppError(
          'MCPB_CONNECTION_CHANGED',
          '连接已被编辑或替换，此安装记录不能卸载当前连接',
          409,
        );
      await this.deps.connections.close(ownerId, row.connectionId);
      const [connection] = await tx
        .select()
        .from(connections)
        .where(and(eq(connections.id, row.connectionId), eq(connections.ownerId, ownerId)))
        .for('update');
      if (!connection || connection.revision !== row.connectionRevision)
        throw new AppError(
          'MCPB_CONNECTION_CHANGED',
          '连接已被编辑或替换，此安装记录不能卸载当前连接',
          409,
        );
      const content = await tx
        .select({ id: mcpEntries.id })
        .from(mcpEntries)
        .where(eq(mcpEntries.connectionId, connection.id));
      const entries = await tx
        .select({ id: tools.id })
        .from(tools)
        .where(eq(tools.connectionId, connection.id));
      await tx.delete(connections).where(eq(connections.id, connection.id));
      const affected = await removeConnectionReferences(tx, {
        connectionId: connection.id,
        contentIds: content.map((r) => r.id),
        toolIds: entries.map((r) => r.id),
      });
      await tx
        .update(mcpbInstalls)
        .set({ state: 'uninstalled', phase: 'uninstalled', error: null })
        .where(eq(mcpbInstalls.id, operationId));
      return affected;
    });
    await this.deps.changed(affected);
    return { uninstalled: true, packageFilesRetained: true };
  }
  async remove(ownerId: string, id: string) {
    await this.deps.db.transaction(async (tx) => {
      const [pkg] = await tx
        .select()
        .from(mcpbPackages)
        .where(and(eq(mcpbPackages.id, id), eq(mcpbPackages.ownerId, ownerId)))
        .for('update');
      const row = requireValue(pkg);
      const operations = await tx.select().from(mcpbInstalls).where(eq(mcpbInstalls.packageId, id));
      if (operations.some((op) => op.state === 'running' || op.connectionId))
        throw new AppError(
          'MCPB_IN_USE',
          '仍有安装操作或关联连接，请先处理安装结果并卸载连接',
          409,
        );
      const directory = this.deps.disk.directory(ownerId, row.sha256);
      const owned = await tx.select().from(connections).where(eq(connections.ownerId, ownerId));
      if (
        owned.some(
          (connection) =>
            this.deps.vault.open<ConnectionInput>(connection.config, `${ownerId}:${connection.id}`)
              .cwd === directory,
        )
      )
        throw new AppError('MCPB_IN_USE', '仍有连接使用此包目录，请先移除相关连接', 409);
      await this.deps.files.remove(id);
      await this.deps.disk.remove(ownerId, row.sha256);
      await tx.update(mcpbPackages).set({ removedAt: new Date() }).where(eq(mcpbPackages.id, id));
    });
    return { removed: true, deviceFilesRetained: true };
  }
}
