import { and, eq } from 'drizzle-orm';
import { sshAccesses, sshBindings, type Database } from '@platform/db';
import {
  sshAccessInput,
  type SshAccessInput,
  type SshAccessView,
  type ConnectionInput,
} from '@platform/contracts';
import { z } from 'zod';
import type { ConnectionService } from '../mcp/connectionService.js';
import { AppError, requireValue } from '../../shared/errors.js';

function bindingError(config: ConnectionInput, remotePort: number) {
  if (
    config.source !== 'mcp' ||
    config.adapter !== 'direct' ||
    config.mode !== 'existing' ||
    !['http', 'sse'].includes(config.transport)
  )
    return 'SSH 只能绑定在平台执行的现有 HTTP/SSE MCP 连接';
  const url = config.url ? new URL(config.url) : undefined;
  if (
    !url ||
    url.hostname !== '127.0.0.1' ||
    Number(url.port || (url.protocol === 'https:' ? 443 : 80)) !== remotePort
  )
    return '连接 URL 必须指向 127.0.0.1 和映射的远端端口，并保留 MCP 路径';
  return null;
}
function conflict(error: unknown): never {
  // Drizzle wraps PostgreSQL errors. Keep database details (including other owners) private.
  const cause = error instanceof Error && error.cause ? error.cause : error;
  if (cause && typeof cause === 'object' && 'code' in cause && cause.code === '23505')
    throw new AppError('SSH_BINDING_CONFLICT', '连接或 SSH 监听端口已被绑定', 409);
  throw error;
}
export class SshAccessService {
  constructor(private readonly deps: { db: Database; connections: ConnectionService }) {}
  async owned(ownerId: string, id: string) {
    const [row] = await this.deps.db
      .select()
      .from(sshAccesses)
      .where(and(eq(sshAccesses.id, id), eq(sshAccesses.ownerId, ownerId)));
    return requireValue(row);
  }
  async list(ownerId: string) {
    const rows = await this.deps.db
      .select()
      .from(sshAccesses)
      .where(eq(sshAccesses.ownerId, ownerId));
    const connections = await this.deps.connections.list(ownerId);
    return Promise.all(
      rows.map(async (row): Promise<SshAccessView> => {
        const bindings = await this.bindings(row.id);
        return {
          ...this.configuration(row),
          bindings,
          id: row.id,
          revision: row.revision,
          tunnelStatus: 'unreported',
          services: await Promise.all(
            bindings.map(async (binding) => {
              const connection = requireValue(
                connections.find((item) => item.id === binding.connectionId),
              );
              const context = await this.deps.connections.context(ownerId, connection.id);
              return {
                connectionId: connection.id,
                name: connection.name,
                status: connection.status,
                error: connection.error,
                configurationError: bindingError(context.config, binding.remotePort),
              };
            }),
          ),
        };
      }),
    );
  }
  private configuration(row: typeof sshAccesses.$inferSelect): Omit<SshAccessInput, 'bindings'> {
    return {
      name: row.name,
      platform: row.platform as SshAccessInput['platform'],
      ssh: {
        host: row.host,
        port: row.port,
        username: row.username,
        identityFile: row.identityFile,
        reconnectIntervalSeconds: row.reconnectIntervalSeconds,
      },
    };
  }
  private bindings(id: string) {
    return this.deps.db
      .select({
        connectionId: sshBindings.connectionId,
        localPort: sshBindings.localPort,
        remotePort: sshBindings.remotePort,
      })
      .from(sshBindings)
      .where(eq(sshBindings.accessId, id));
  }
  private async validate(ownerId: string, input: unknown) {
    const config = sshAccessInput.parse(input);
    for (const binding of config.bindings) {
      await this.deps.connections.owned(ownerId, binding.connectionId);
      const context = await this.deps.connections.context(ownerId, binding.connectionId);
      const error = bindingError(context.config, binding.remotePort);
      if (error) throw new AppError('SSH_CONNECTION', error);
    }
    return config;
  }
  async save(ownerId: string, input: unknown, update?: { id: string; revision: number }) {
    if (update) await this.owned(ownerId, update.id);
    const config = await this.validate(ownerId, input);
    try {
      return await this.deps.db.transaction(async (tx) => {
        const values = {
          ownerId,
          name: config.name,
          platform: config.platform,
          ...config.ssh,
          updatedAt: new Date(),
        };
        const [row] = update
          ? await tx
              .update(sshAccesses)
              .set({ ...values, revision: update.revision + 1 })
              .where(
                and(
                  eq(sshAccesses.id, update.id),
                  eq(sshAccesses.ownerId, ownerId),
                  eq(sshAccesses.revision, update.revision),
                ),
              )
              .returning()
          : await tx.insert(sshAccesses).values(values).returning();
        if (!row) throw new AppError('REVISION_CONFLICT', 'SSH 接入已变化，请重新加载', 409);
        await tx.delete(sshBindings).where(eq(sshBindings.accessId, row.id));
        await tx
          .insert(sshBindings)
          .values(
            config.bindings.map((binding) => ({
              ...binding,
              accessId: row.id,
              host: config.ssh.host,
              port: config.ssh.port,
            })),
          );
        return { id: row.id, revision: row.revision };
      });
    } catch (error) {
      conflict(error);
    }
  }
  async bundleConfig(ownerId: string, id: string) {
    const row = await this.owned(ownerId, id);
    const configuration = await this.validate(ownerId, {
      ...this.configuration(row),
      bindings: await this.bindings(id),
    });
    return { ...configuration, id };
  }
  async remove(ownerId: string, id: string, revision: unknown) {
    await this.owned(ownerId, id);
    const rows = await this.deps.db
      .delete(sshAccesses)
      .where(
        and(
          eq(sshAccesses.id, id),
          eq(sshAccesses.ownerId, ownerId),
          eq(sshAccesses.revision, z.number().int().positive().parse(revision)),
        ),
      )
      .returning({ id: sshAccesses.id });
    if (!rows.length) throw new AppError('REVISION_CONFLICT', 'SSH 接入已变化，请重新加载', 409);
  }
}
