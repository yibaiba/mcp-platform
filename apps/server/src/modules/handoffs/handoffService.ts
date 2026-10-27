import { randomUUID } from 'node:crypto';
import { and, eq, gt, isNull, or, inArray } from 'drizzle-orm';
import {
  handoffs,
  profiles,
  tasks,
  artifacts,
  temporaryGrants,
  accessKeys,
  oauthGrants,
  type Database,
} from '@platform/db';
import { z } from 'zod';
import { AppError, errorMessage, requireValue } from '../../shared/errors.js';
const selection = z
  .object({
    sourceTaskId: z.uuid(),
    targetProfileId: z.uuid(),
    targetRevision: z.number().int().positive(),
    summary: z.string().trim().min(1),
    artifactIds: z.array(z.uuid()),
    mode: z.enum(['pi', 'external']),
    credentialId: z.uuid().optional(),
  })
  .strict();
const createInput = selection.extend({ idempotencyKey: z.string().min(1) });
type Selection = z.infer<typeof selection>;
const ARTIFACT_GRANT_MS = 60 * 60_000;
export class HandoffService {
  constructor(
    private readonly deps: {
      db: Database;
      start: (
        ownerId: string,
        input: { profileId: string; prompt: string },
        reservedId: string,
      ) => Promise<unknown>;
      publicUrl: string;
      fail: (taskId: string, error: string) => Promise<unknown>;
    },
  ) {}
  async preview(ownerId: string, input: unknown) {
    const value = selection.parse(input);
    const target = await this.validate(ownerId, value);
    return {
      ...value,
      targetPermissions: {
        toolIds: target.toolIds,
        contentIds: target.contentIds,
        artifactIds: target.artifactIds,
      },
      additionalArtifactIds: value.artifactIds.filter((id) => !target.artifactIds.includes(id)),
      artifactGrantExpiresInMs: ARTIFACT_GRANT_MS,
      source: { taskId: value.sourceTaskId },
      included: '仅所填摘要及选定产物；不复制会话、凭证或 Apps 状态',
    };
  }
  private async validate(
    ownerId: string,
    value: Selection,
    db: Pick<Database, 'select'> = this.deps.db,
  ) {
    const [source] = await db
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, value.sourceTaskId), eq(tasks.ownerId, ownerId)));
    const [target] = await db
      .select()
      .from(profiles)
      .where(and(eq(profiles.id, value.targetProfileId), eq(profiles.ownerId, ownerId)));
    requireValue(source);
    requireValue(target);
    if (target!.revision !== value.targetRevision)
      throw new AppError('REVISION_CONFLICT', '目标 Agent 配置已变化，请重新预览', 409);
    const files = value.artifactIds.length
      ? await db
          .select()
          .from(artifacts)
          .where(and(eq(artifacts.ownerId, ownerId), inArray(artifacts.id, value.artifactIds)))
      : [];
    if (
      files.length !== new Set(value.artifactIds).size ||
      files.some((file) => file.taskId !== source!.id)
    )
      throw new AppError('HANDOFF_SOURCE', '只能交接源任务关联的产物', 403);
    if (value.mode === 'external') await this.credential(ownerId, value, db);
    return target!;
  }
  private async credential(ownerId: string, value: Selection, db: Pick<Database, 'select'>) {
    if (!value.credentialId)
      throw new AppError('HANDOFF_CREDENTIAL', '外部目标必须选择目标 Agent 的有效接入凭证');
    const now = new Date();
    const [key] = await db
      .select()
      .from(accessKeys)
      .where(
        and(
          eq(accessKeys.id, value.credentialId),
          eq(accessKeys.ownerId, ownerId),
          eq(accessKeys.profileId, value.targetProfileId),
          eq(accessKeys.revoked, false),
          or(isNull(accessKeys.expiresAt), gt(accessKeys.expiresAt, now)),
        ),
      );
    if (key) return;
    const [grant] = await db
      .select()
      .from(oauthGrants)
      .where(
        and(
          eq(oauthGrants.id, value.credentialId),
          eq(oauthGrants.ownerId, ownerId),
          eq(oauthGrants.profileId, value.targetProfileId),
          eq(oauthGrants.revoked, false),
          gt(oauthGrants.expiresAt, now),
        ),
      );
    if (!grant) throw new AppError('HANDOFF_CREDENTIAL', '接入凭证无效或不属于目标 Agent', 403);
  }
  async create(ownerId: string, input: unknown) {
    const value = createInput.parse(input);
    return this.deps.db.transaction(async (tx) => {
      await tx.select().from(profiles).where(eq(profiles.id, value.targetProfileId)).for('update');
      await this.validate(ownerId, value, tx);
      await tx
        .insert(handoffs)
        .values({ id: randomUUID(), ownerId, ...value, status: 'created' })
        .onConflictDoNothing();
      const [row] = await tx
        .select()
        .from(handoffs)
        .where(
          and(eq(handoffs.ownerId, ownerId), eq(handoffs.idempotencyKey, value.idempotencyKey)),
        );
      const handoff = requireValue(row);
      if (
        handoff.summary !== value.summary ||
        handoff.targetProfileId !== value.targetProfileId ||
        handoff.sourceTaskId !== value.sourceTaskId ||
        handoff.mode !== value.mode ||
        handoff.credentialId !== (value.credentialId ?? null) ||
        JSON.stringify(handoff.artifactIds) !== JSON.stringify(value.artifactIds)
      )
        throw new AppError('IDEMPOTENCY_CONFLICT', '幂等键已用于其他交接', 409);
      return handoff;
    });
  }
  list(ownerId: string) {
    return this.deps.db.select().from(handoffs).where(eq(handoffs.ownerId, ownerId));
  }
  async owned(ownerId: string, id: string) {
    const [row] = await this.deps.db
      .select()
      .from(handoffs)
      .where(and(eq(handoffs.id, id), eq(handoffs.ownerId, ownerId)));
    return requireValue(row);
  }
  private selected(row: typeof handoffs.$inferSelect): Selection {
    return { ...row, credentialId: row.credentialId ?? undefined };
  }
  async execute(ownerId: string, id: string) {
    const result = await this.deps.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(handoffs)
        .where(and(eq(handoffs.id, id), eq(handoffs.ownerId, ownerId)))
        .for('update');
      const handoff = requireValue(row);
      if (handoff.status !== 'created') return { handoff, claimed: false };
      await tx
        .select()
        .from(profiles)
        .where(eq(profiles.id, handoff.targetProfileId))
        .for('update');
      let target;
      try {
        target = await this.validate(ownerId, this.selected(handoff), tx);
      } catch (error) {
        if (!(error instanceof AppError)) throw error;
        const [failed] = await tx
          .update(handoffs)
          .set({ status: 'failed', error: error.message })
          .where(eq(handoffs.id, id))
          .returning();
        return { handoff: requireValue(failed), claimed: false, error };
      }
      const taskId = handoff.mode === 'pi' ? randomUUID() : null;
      if (taskId)
        await tx.insert(tasks).values({
          id: taskId,
          ownerId,
          profileId: target.id,
          prompt: handoff.summary,
          handoffId: id,
          status: 'queued',
        });
      await tx.insert(temporaryGrants).values({
        id: randomUUID(),
        ownerId,
        profileId: target.id,
        profileRevision: target.revision,
        subject: taskId ? `task:${taskId}` : `credential:${handoff.credentialId}`,
        taskId,
        bindings: {},
        permissions: {
          toolIds: [],
          contentIds: [],
          artifactIds: handoff.artifactIds.filter((id) => !target.artifactIds.includes(id)),
        },
        expiresAt: new Date(Date.now() + ARTIFACT_GRANT_MS),
      });
      const [updated] = await tx
        .update(handoffs)
        .set({ status: taskId ? 'executing' : 'exported', taskId })
        .where(eq(handoffs.id, id))
        .returning();
      return { handoff: requireValue(updated), claimed: true };
    });
    if ('error' in result) throw result.error;
    if (!result.claimed || result.handoff.mode === 'external') return result.handoff;
    try {
      await this.deps.start(
        ownerId,
        {
          profileId: result.handoff.targetProfileId,
          prompt: JSON.stringify(this.packet(result.handoff)),
        },
        result.handoff.taskId!,
      );
      return result.handoff;
    } catch (error) {
      await this.deps.fail(result.handoff.taskId!, errorMessage(error));
      return this.owned(ownerId, id);
    }
  }
  async export(ownerId: string, id: string) {
    const row = await this.owned(ownerId, id);
    await this.validate(ownerId, this.selected(row));
    return this.packet(row);
  }
  private packet(row: typeof handoffs.$inferSelect) {
    return {
      id: row.id,
      source: { taskId: row.sourceTaskId },
      targetProfileId: row.targetProfileId,
      summary: row.summary,
      artifacts: row.artifactIds.map((id) => ({
        id,
        url: `${this.deps.publicUrl}/mcp/${row.targetProfileId}/artifacts/${id}`,
        authentication:
          row.mode === 'pi'
            ? '使用当前新任务的 platform_artifacts_read 工具，按产物 ID 指定字节区间；不继承外部接入凭证'
            : '使用所选目标接入凭证；此入口没有公开下载令牌',
      })),
    };
  }
}
