import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  connectionShares,
  connections,
  mcpEntries,
  tools,
  user,
  type Database,
} from '@platform/db';
import { connectionInput, type ConnectionInput } from '@platform/contracts';
import { z } from 'zod';
import type { Vault } from '../../shared/crypto.js';
import { AppError, requireValue } from '../../shared/errors.js';
import { ShareAccess } from './shareAccess.js';
import type { ConnectionContext } from '../mcp/adapter.js';
import type { ConnectionService } from '../mcp/connectionService.js';
const grantInput = z
  .object({
    recipientEmail: z.email().transform((value) => value.toLowerCase()),
    credentialMode: z.enum(['independent', 'owner']).default('independent'),
    toolIds: z.array(z.string().min(1)).default([]),
    contentIds: z.array(z.string().min(1)).default([]),
    version: z.number().int().positive().optional(),
  })
  .strict();
export class ShareService extends ShareAccess {
  constructor(
    private readonly deps: {
      db: Database;
      vault: Vault;
      validate: (ownerId: string, input: unknown) => Promise<ConnectionInput>;
      changed: (shareId: string) => Promise<void>;
      recovery: ConnectionService['recovery'];
    },
  ) {
    super(deps.db);
  }
  private async source(ownerId: string, id: string) {
    const [row] = await this.db
      .select()
      .from(connections)
      .where(and(eq(connections.id, id), eq(connections.ownerId, ownerId)));
    return requireValue(row);
  }
  async outgoing(ownerId: string, id: string) {
    await this.source(ownerId, id);
    const rows = await this.db
      .select({ grant: connectionShares, email: user.email, name: user.name })
      .from(connectionShares)
      .innerJoin(user, eq(user.id, connectionShares.recipientId))
      .where(eq(connectionShares.connectionId, id));
    return rows.map(({ grant: { receiverConfig: _private, ...grant }, ...recipient }) => ({
      ...grant,
      ...recipient,
    }));
  }
  async catalog(ownerId: string, id: string) {
    await this.source(ownerId, id);
    const [toolRows, contentRows] = await Promise.all([
      this.db
        .select({ id: tools.id, name: tools.name })
        .from(tools)
        .where(eq(tools.connectionId, id)),
      this.db
        .select({ id: mcpEntries.id, name: mcpEntries.name, kind: mcpEntries.kind })
        .from(mcpEntries)
        .where(eq(mcpEntries.connectionId, id)),
    ]);
    return { tools: toolRows, content: contentRows };
  }
  async incoming(ownerId: string) {
    const grants = await this.grants(ownerId);
    return Promise.all(
      grants.map(async ({ receiverConfig, ...grant }) => {
        const source = await this.source(grant.ownerId, grant.connectionId);
        const pending = grant.credentialMode === 'independent' && !receiverConfig;
        const config = receiverConfig
          ? this.config(ownerId, { ...grant, receiverConfig })
          : undefined;
        return {
          ...grant,
          name: source.name,
          adapter: source.adapter,
          status: pending ? 'pending' : grant.status,
          transport: config?.transport,
          recovery: this.deps.recovery(ownerId, grant.connectionId),
          source: config?.source,
          pendingReason: pending ? '请配置自己的上游身份、执行位置和本地资源后连接' : null,
        };
      }),
    );
  }
  async save(ownerId: string, connectionId: string, input: unknown) {
    await this.source(ownerId, connectionId);
    const value = grantInput.parse(input);
    const [recipient] = await this.db
      .select()
      .from(user)
      .where(and(eq(user.email, value.recipientEmail), eq(user.enabled, true)));
    if (!recipient || recipient.id === ownerId)
      throw new AppError('SHARE_RECIPIENT', '接收账号必须是已启用的其他账号');
    await this.validateCapabilities(connectionId, value);
    const row = await this.db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(connectionShares)
        .where(
          and(
            eq(connectionShares.connectionId, connectionId),
            eq(connectionShares.recipientId, recipient.id),
          ),
        )
        .for('update');
      const selected = {
        credentialMode: value.credentialMode,
        toolIds: [...new Set(value.toolIds)],
        contentIds: [...new Set(value.contentIds)],
        revoked: false,
        status: 'disconnected',
        error: null,
      };
      if (!existing)
        return requireValue(
          (
            await tx
              .insert(connectionShares)
              .values({ ...selected, ownerId, connectionId, recipientId: recipient.id })
              .returning()
          )[0],
        );
      if (value.version !== existing.version)
        throw new AppError('REVISION_CONFLICT', '共享授权已变化，请重新加载', 409);
      return requireValue(
        (
          await tx
            .update(connectionShares)
            .set({ ...selected, version: existing.version + 1 })
            .where(eq(connectionShares.id, existing.id))
            .returning()
        )[0],
      );
    });
    await this.deps.changed(row.id);
    const { receiverConfig: _private, ...publicRow } = row;
    return publicRow;
  }
  private async validateCapabilities(connectionId: string, value: z.infer<typeof grantInput>) {
    for (const [ids, table] of [
      [value.toolIds, tools],
      [value.contentIds, mcpEntries],
    ] as const) {
      const unique = [...new Set(ids)];
      const rows = unique.length
        ? await this.db
            .select({ id: table.id })
            .from(table)
            .where(and(eq(table.connectionId, connectionId), inArray(table.id, unique)))
        : [];
      if (rows.length !== unique.length)
        throw new AppError('SHARE_CAPABILITIES', '只能共享该连接真实目录中的能力');
    }
  }
  async revoke(ownerId: string, id: string, version?: number) {
    await this.revokeWithCheckpoint({ ownerId, id, version });
  }
  async revokeWithCheckpoint(input: {
    ownerId: string;
    id: string;
    version?: number;
    checkpoint?: (db: Pick<Database, 'update'>) => Promise<unknown>;
  }) {
    await this.db.transaction(async (tx) => {
      const rows = await tx
        .update(connectionShares)
        .set({ revoked: true, version: sql`${connectionShares.version} + 1` })
        .where(
          and(
            eq(connectionShares.id, input.id),
            eq(connectionShares.ownerId, input.ownerId),
            input.version === undefined ? undefined : eq(connectionShares.version, input.version),
          ),
        )
        .returning();
      requireValue(rows[0]);
      await input.checkpoint?.(tx);
    });
    await this.deps.changed(input.id);
  }
  async configure(recipientId: string, id: string, input: unknown) {
    const share = (await this.grants(recipientId)).find((row) => row.id === id);
    if (!share) throw new AppError('SHARE_REVOKED', '共享授权不存在或已撤销', 403);
    if (share.credentialMode !== 'independent')
      throw new AppError('SHARE_OWNER_CREDENTIALS', '此共享使用所有者身份，由所有者管理凭证', 403);
    const config = await this.deps.validate(recipientId, input);
    const rows = await this.db
      .update(connectionShares)
      .set({
        receiverConfig: this.deps.vault.seal(config, `share:${recipientId}:${id}`),
        version: sql`${connectionShares.version} + 1`,
        status: 'disconnected',
        error: null,
      })
      .where(
        and(
          eq(connectionShares.id, id),
          eq(connectionShares.version, share.version),
          eq(connectionShares.revoked, false),
        ),
      )
      .returning();
    if (!rows.length) throw new AppError('REVISION_CONFLICT', '共享授权已变化，请重新加载', 409);
    await this.deps.changed(id);
    return { configured: true };
  }
  config(recipientId: string, share: typeof connectionShares.$inferSelect) {
    if (!share.receiverConfig)
      throw new AppError(
        'SHARE_CONFIGURATION_PENDING',
        '接收者尚未配置独立身份、设备或本地资源',
        409,
      );
    return connectionInput.parse(
      this.deps.vault.open(share.receiverConfig, `share:${recipientId}:${share.id}`),
    );
  }
  async assertContext(context: ConnectionContext) {
    if (!context.shareId) return;
    const { share, connection } = await this.connection(context.ownerId, context.id);
    if (
      !share ||
      share.id !== context.shareId ||
      share.version !== context.shareVersion ||
      connection.revision !== context.revision
    )
      throw new AppError('SHARE_SUPERSEDED', '共享授权或连接已变化', 403);
  }
  async state(context: ConnectionContext, status: string, error?: string) {
    if (!context.shareId) return;
    await this.db
      .update(connectionShares)
      .set({ status, error: error ?? null })
      .where(
        and(
          eq(connectionShares.id, context.shareId),
          eq(connectionShares.version, context.shareVersion!),
          eq(connectionShares.revoked, false),
        ),
      );
  }
}
