import { and, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import {
  connectionShares,
  connectionTeamShares,
  connections,
  mcpEntries,
  tools,
  user,
  type Database,
} from '@platform/db';
import { connectionInput, toolAnnotations, type ConnectionInput } from '@platform/contracts';
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
const teamInput = z
  .object({
    credentialMode: z.enum(['independent', 'owner']).default('independent'),
    toolIds: z.array(z.string().min(1)).default([]),
    contentIds: z.array(z.string().min(1)).default([]),
    version: z.number().int().positive().optional(),
  })
  .strict();
type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
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
      .select({
        grant: connectionShares,
        email: user.email,
        name: user.name,
        enabled: user.enabled,
      })
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
        .select({ id: tools.id, name: tools.name, definition: tools.definition })
        .from(tools)
        .where(eq(tools.connectionId, id)),
      this.db
        .select({ id: mcpEntries.id, name: mcpEntries.name, kind: mcpEntries.kind })
        .from(mcpEntries)
        .where(eq(mcpEntries.connectionId, id)),
    ]);
    // Annotations only: the picker labels tools as read-only / destructive / undeclared.
    return {
      tools: toolRows.map(({ definition, ...tool }) => ({
        ...tool,
        annotations: toolAnnotations(definition),
      })),
      content: contentRows,
    };
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
          pendingReason: pending ? '请配置自己的服务账号身份、运行位置和本地资源后连接' : null,
        };
      }),
    );
  }
  async save(ownerId: string, connectionId: string, input: unknown) {
    const source = await this.source(ownerId, connectionId);
    if (
      this.deps.vault.open<ConnectionInput>(source.config, `${ownerId}:${connectionId}`).source ===
      'library'
    )
      throw new AppError(
        'LIBRARY_SHARE_UNSUPPORTED',
        '提示词与资源通过当前账号的 Agent 授权，不提供跨账号共享',
      );
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
      // A team copy (or a revoked row) becomes this direct grant; only an active direct
      // grant needs the caller's version.
      const replacing = existing.teamShareId !== null || existing.revoked;
      if (value.version !== existing.version && !(replacing && value.version === undefined))
        throw new AppError('REVISION_CONFLICT', '共享授权已变化，请重新加载', 409);
      return requireValue(
        (
          await tx
            .update(connectionShares)
            .set({ ...selected, teamShareId: null, version: existing.version + 1 })
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
    return this.revokeWithCheckpoint({ ownerId, id, version });
  }
  /** The active-or-revoked team grant of an owned connection, with its audience size. */
  async team(ownerId: string, connectionId: string) {
    await this.source(ownerId, connectionId);
    const [team] = await this.db
      .select()
      .from(connectionTeamShares)
      .where(eq(connectionTeamShares.connectionId, connectionId));
    if (!team) return null;
    const [counts] = await this.db
      .execute<{ members: number; excluded: number; direct: number }>(
        sql`
      select
        count(*) filter (where s."team_share_id" = ${team.id} and not s."revoked")::int as members,
        count(*) filter (where s."team_share_id" = ${team.id} and s."revoked")::int as excluded,
        count(*) filter (where s."team_share_id" is null and not s."revoked")::int as direct
      from "connection_shares" s join "user" u on u."id" = s."recipient_id" and u."enabled"
      where s."connection_id" = ${connectionId}`,
      )
      .then((result) => result.rows);
    // Accounts that have not opened the platform since the grant still count as members.
    const [pending] = await this.db
      .execute<{ count: number }>(
        sql`
      select count(*)::int as count from "user" u
      where u."enabled" and u."id" <> ${ownerId}
        and not exists (select 1 from "connection_shares" s
                        where s."connection_id" = ${connectionId} and s."recipient_id" = u."id")`,
      )
      .then((result) => result.rows);
    return {
      ...team,
      members: team.revoked ? 0 : (counts?.members ?? 0) + (pending?.count ?? 0),
      excluded: counts?.excluded ?? 0,
      direct: counts?.direct ?? 0,
    };
  }
  /** Shares with every enabled account except the owner, now and later (admins only). */
  async saveTeam(ownerId: string, connectionId: string, input: unknown) {
    const source = await this.source(ownerId, connectionId);
    const [owner] = await this.db.select().from(user).where(eq(user.id, ownerId));
    if (owner?.role !== 'admin')
      throw new AppError('TEAM_SHARE_ADMIN_ONLY', '只有管理员可以共享给所有成员', 403);
    if (
      this.deps.vault.open<ConnectionInput>(source.config, `${ownerId}:${connectionId}`).source ===
      'library'
    )
      throw new AppError(
        'LIBRARY_SHARE_UNSUPPORTED',
        '提示词与资源通过当前账号的 Agent 授权，不提供跨账号共享',
      );
    const value = teamInput.parse(input);
    await this.validateCapabilities(connectionId, {
      ...value,
      recipientEmail: 'team@example.invalid',
    });
    const selected = {
      credentialMode: value.credentialMode,
      toolIds: [...new Set(value.toolIds)],
      contentIds: [...new Set(value.contentIds)],
    };
    const { team, touched } = await this.db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(connectionTeamShares)
        .where(eq(connectionTeamShares.connectionId, connectionId))
        .for('update');
      if (existing && !existing.revoked && value.version !== existing.version)
        throw new AppError('REVISION_CONFLICT', '全员共享已变化，请重新加载', 409);
      const reactivating = !existing || existing.revoked;
      const team = requireValue(
        existing
          ? (
              await tx
                .update(connectionTeamShares)
                .set({ ...selected, revoked: false, version: existing.version + 1 })
                .where(eq(connectionTeamShares.id, existing.id))
                .returning()
            )[0]
          : (
              await tx
                .insert(connectionTeamShares)
                .values({ ...selected, ownerId, connectionId })
                .returning()
            )[0],
      );
      return { team, touched: await this.syncTeam(tx, team, reactivating) };
    });
    for (const id of touched) await this.deps.changed(id);
    return team;
  }
  /** Brings every member copy in line with the team grant; returns the changed row ids. */
  private async syncTeam(
    tx: Tx,
    team: typeof connectionTeamShares.$inferSelect,
    reactivating: boolean,
  ) {
    const fields = {
      credentialMode: team.credentialMode,
      toolIds: team.toolIds,
      contentIds: team.contentIds,
      status: 'disconnected',
      error: null,
      version: sql`${connectionShares.version} + 1`,
    };
    // Existing copies follow the grant; exclusions survive edits but not a fresh grant.
    const copies = await tx
      .update(connectionShares)
      .set(reactivating ? { ...fields, revoked: false } : fields)
      .where(eq(connectionShares.teamShareId, team.id))
      .returning({ id: connectionShares.id });
    // A revoked direct grant no longer outranks the team grant.
    const formerDirect = await tx
      .update(connectionShares)
      .set({ ...fields, teamShareId: team.id, revoked: false })
      .where(
        and(
          eq(connectionShares.connectionId, team.connectionId),
          isNull(connectionShares.teamShareId),
          eq(connectionShares.revoked, true),
        ),
      )
      .returning({ id: connectionShares.id });
    const members = await tx
      .select({ id: user.id })
      .from(user)
      .where(and(eq(user.enabled, true), ne(user.id, team.ownerId)));
    const added = members.length
      ? await tx
          .insert(connectionShares)
          .values(
            members.map((member) => ({
              connectionId: team.connectionId,
              ownerId: team.ownerId,
              recipientId: member.id,
              credentialMode: team.credentialMode,
              toolIds: team.toolIds,
              contentIds: team.contentIds,
              teamShareId: team.id,
            })),
          )
          .onConflictDoNothing()
          .returning({ id: connectionShares.id })
      : [];
    return [...copies, ...formerDirect, ...added].map((row) => row.id);
  }
  /** Ends the team grant: every member copy is revoked; direct grants are unaffected. */
  async revokeTeam(ownerId: string, connectionId: string) {
    await this.source(ownerId, connectionId);
    const touched = await this.db.transaction(async (tx) => {
      const [team] = await tx
        .update(connectionTeamShares)
        .set({ revoked: true, version: sql`${connectionTeamShares.version} + 1` })
        .where(
          and(
            eq(connectionTeamShares.connectionId, connectionId),
            eq(connectionTeamShares.revoked, false),
          ),
        )
        .returning();
      if (!team) throw new AppError('NOT_FOUND', '没有生效中的全员共享', 404);
      return tx
        .update(connectionShares)
        .set({ revoked: true, version: sql`${connectionShares.version} + 1` })
        .where(and(eq(connectionShares.teamShareId, team.id), eq(connectionShares.revoked, false)))
        .returning({ id: connectionShares.id });
    });
    for (const { id } of touched) await this.deps.changed(id);
    return { revoked: true, members: touched.length };
  }
  async revokeWithCheckpoint(input: {
    ownerId: string;
    id: string;
    version?: number;
    checkpoint?: (db: Pick<Database, 'update'>) => Promise<unknown>;
  }) {
    const outcome = await this.db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(connectionShares)
        .where(and(eq(connectionShares.id, input.id), eq(connectionShares.ownerId, input.ownerId)))
        .for('update');
      const [team] = current
        ? await tx
            .select()
            .from(connectionTeamShares)
            .where(
              and(
                eq(connectionTeamShares.connectionId, current.connectionId),
                eq(connectionTeamShares.revoked, false),
              ),
            )
        : [];
      // Revoking a direct grant of someone who is also in an active team grant leaves them
      // with the team grant (4A: direct wins only while it exists). Revoking a team copy
      // excludes that account from the team grant.
      const fallback = Boolean(team && current && current.teamShareId === null && !current.revoked);
      const rows = await tx
        .update(connectionShares)
        .set(
          fallback
            ? {
                teamShareId: team!.id,
                credentialMode: team!.credentialMode,
                toolIds: team!.toolIds,
                contentIds: team!.contentIds,
                status: 'disconnected',
                error: null,
                version: sql`${connectionShares.version} + 1`,
              }
            : { revoked: true, version: sql`${connectionShares.version} + 1` },
        )
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
      return { fallback: fallback ? ('team' as const) : null };
    });
    await this.deps.changed(input.id);
    return outcome;
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
