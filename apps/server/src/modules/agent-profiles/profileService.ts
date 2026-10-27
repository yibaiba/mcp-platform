import type { AccessService } from '../permissions/accessService.js';
import { describeTools } from './toolPresentation.js';
import { and, eq, inArray, gt, isNull, or, sql } from 'drizzle-orm';
import {
  profiles,
  connections,
  artifacts,
  tools,
  mcpEntries,
  accessKeys,
  oauthGrants,
  skillVersions,
  type Database,
} from '@platform/db';
import { profileInput } from '@platform/contracts';
import { digest, secretToken } from '../../shared/crypto.js';
import { AppError, requireValue } from '../../shared/errors.js';
export type Principal = { ownerId: string; profileId: string; credentialId: string; token: string };
import type { ConnectionService } from '../mcp/connectionService.js';
export class ProfileService {
  access?: AccessService;
  constructor(
    private readonly db: Database,
    private readonly connections?: ConnectionService,
  ) {}
  async owned(ownerId: string, id: string) {
    const [profile] = await this.db
      .select()
      .from(profiles)
      .where(and(eq(profiles.id, id), eq(profiles.ownerId, ownerId)));
    return requireValue(profile);
  }
  async save(ownerId: string, input: unknown, id?: string) {
    const previous = id ? await this.owned(ownerId, id) : undefined;
    const value = profileInput.parse(
      previous
        ? {
            requestable: previous.requestable,
            connectionIdentities: previous.connectionIdentities,
            ...(input as object),
          }
        : input,
    );
    if (previous && value.revision !== undefined && value.revision !== previous.revision)
      throw new AppError('REVISION_CONFLICT', '配置已改变，请重新加载', 409);
    await this.validateRequestable(ownerId, value);
    const contentIds = [...new Set(value.contentIds)];
    const entries = contentIds.length
      ? await this.db
          .select()
          .from(mcpEntries)
          .where(and(eq(mcpEntries.ownerId, ownerId), inArray(mcpEntries.id, contentIds)))
      : [];
    if (entries.length !== contentIds.length)
      throw new AppError('INVALID_GRANTS', '选择的 Prompt 或 Resource 不属于当前用户');
    const toolIds = [...new Set(value.toolIds)];
    const versionIds = [...new Set(value.skillVersionIds)];
    const validTools = toolIds.length
      ? await this.db
          .select()
          .from(tools)
          .where(and(eq(tools.ownerId, ownerId), inArray(tools.id, toolIds)))
      : [];
    const versions = versionIds.length
      ? await this.db
          .select()
          .from(skillVersions)
          .where(and(eq(skillVersions.ownerId, ownerId), inArray(skillVersions.id, versionIds)))
      : [];
    const artifactIds = [...new Set(value.artifactIds)];
    const grantedFiles = artifactIds.length
      ? await this.db
          .select()
          .from(artifacts)
          .where(and(eq(artifacts.ownerId, ownerId), inArray(artifacts.id, artifactIds)))
      : [];
    if (grantedFiles.length !== artifactIds.length)
      throw new AppError('INVALID_GRANTS', '选择的产物不属于当前用户');
    if (validTools.length !== toolIds.length || versions.length !== versionIds.length)
      throw new AppError('INVALID_GRANTS', '选择的工具或 Skill 版本不属于当前用户');
    if (versions.some((v) => v.dependencies.some((t) => !toolIds.includes(t))))
      throw new AppError('SKILL_DEPENDENCY', 'Skill 依赖的 MCP 工具尚未授权');
    if (new Set(versions.map((v) => v.name)).size !== versions.length)
      throw new AppError('SKILL_DUPLICATE', '每个 Skill 只能选择一个版本');
    if (id) {
      const [profile] = await this.db
        .update(profiles)
        .set({
          ...value,
          artifactIds,
          contentIds,
          toolIds,
          skillVersionIds: versionIds,
          revision: sql`${profiles.revision} + 1`,
        })
        .where(and(eq(profiles.id, id), eq(profiles.revision, previous!.revision)))
        .returning();
      if (!profile) throw new AppError('REVISION_CONFLICT', '配置已改变，请重新加载', 409);
      return profile;
    }
    const [profile] = await this.db
      .insert(profiles)
      .values({ ...value, contentIds, ownerId, toolIds, skillVersionIds: versionIds })
      .returning();
    return profile;
  }
  private async validateRequestable(ownerId: string, value: ReturnType<typeof profileInput.parse>) {
    for (const [kind, table] of [
      ['toolIds', tools],
      ['contentIds', mcpEntries],
      ['artifactIds', artifacts],
    ] as const) {
      const ids = [...new Set(value.requestable?.[kind] ?? [])];
      const rows = ids.length
        ? await this.db
            .select({ id: table.id })
            .from(table)
            .where(and(eq(table.ownerId, ownerId), inArray(table.id, ids)))
        : [];
      if (rows.length !== ids.length)
        throw new AppError('INVALID_GRANTS', '可申请能力必须属于当前用户');
    }
    for (const id of Object.keys(value.connectionIdentities ?? {})) {
      const [row] = await this.db
        .select({ id: connections.id })
        .from(connections)
        .where(and(eq(connections.id, id), eq(connections.ownerId, ownerId)));
      if (!row) throw new AppError('INVALID_IDENTITY', '身份连接不属于当前用户');
    }
  }
  list(ownerId: string) {
    return this.db.select().from(profiles).where(eq(profiles.ownerId, ownerId));
  }
  async issue(ownerId: string, id: string) {
    await this.owned(ownerId, id);
    const token = secretToken();
    const [key] = await this.db
      .insert(accessKeys)
      .values({ ownerId, profileId: id, name: 'Agent key', hash: digest(token) })
      .returning({ id: accessKeys.id });
    return { id: requireValue(key).id, token };
  }
  keys(ownerId: string) {
    return this.db
      .select({
        id: accessKeys.id,
        profileId: accessKeys.profileId,
        revoked: accessKeys.revoked,
        createdAt: accessKeys.createdAt,
      })
      .from(accessKeys)
      .where(eq(accessKeys.ownerId, ownerId));
  }
  async revoke(ownerId: string, id: string) {
    const rows = await this.db
      .update(accessKeys)
      .set({ revoked: true })
      .where(and(eq(accessKeys.id, id), eq(accessKeys.ownerId, ownerId)))
      .returning();
    requireValue(rows[0]);
  }
  async authenticate(profileId: string, token: string): Promise<Principal> {
    const hash = digest(token);
    const [key] = await this.db
      .select()
      .from(accessKeys)
      .where(
        and(
          eq(accessKeys.hash, hash),
          eq(accessKeys.profileId, profileId),
          eq(accessKeys.revoked, false),
          or(isNull(accessKeys.expiresAt), gt(accessKeys.expiresAt, new Date())),
        ),
      );
    if (key) return { ownerId: key.ownerId, profileId, credentialId: key.id, token };
    const [grant] = await this.db
      .select()
      .from(oauthGrants)
      .where(
        and(
          eq(oauthGrants.accessHash, hash),
          eq(oauthGrants.profileId, profileId),
          eq(oauthGrants.revoked, false),
          gt(oauthGrants.expiresAt, new Date()),
        ),
      );
    if (grant) return { ownerId: grant.ownerId, profileId, credentialId: grant.id, token };
    throw new AppError('UNAUTHORIZED', 'Agent 凭证无效、已过期或已撤销', 401);
  }
  private async scopedCatalog(ownerId: string, rows: (typeof tools.$inferSelect)[]) {
    if (!this.connections) return rows;
    const snapshots = new Map(
      await Promise.all(
        [...new Set(rows.map((row) => row.connectionId))].map(async (id) => {
          const snapshot = await this.connections!.catalogForAccess(ownerId, id);
          return [id, snapshot] as const;
        }),
      ),
    );
    return rows.flatMap((row) => {
      const definition = snapshots
        .get(row.connectionId)
        ?.tools.find((tool) => tool.name === row.name);
      return definition ? [{ ...row, definition }] : [];
    });
  }
  async instructions(ownerId: string, profileId: string) {
    const profile = await this.owned(ownerId, profileId);
    const catalog = await this.catalog(ownerId, profileId);
    const content = profile.contentIds.length
      ? await this.db
          .select({ connectionId: mcpEntries.connectionId })
          .from(mcpEntries)
          .where(and(eq(mcpEntries.ownerId, ownerId), inArray(mcpEntries.id, profile.contentIds)))
      : [];
    const ids = [...new Set([...catalog, ...content].map((row) => row.connectionId))].sort();
    const descriptions = await Promise.all(
      ids.map(async (id) => {
        const row = await this.connections?.owned(ownerId, id);
        const snapshot = await this.connections?.catalogForAccess(ownerId, id);
        const text = snapshot?.instructions;
        return text ? `[${row?.name ?? id} · ${id}]\n${text}` : '';
      }),
    );
    return [profile.instructions, ...descriptions].filter(Boolean).join('\n\n');
  }
  async potentialCatalog(ownerId: string, profileId: string) {
    const profile = await this.owned(ownerId, profileId);
    const ids = [...new Set([...profile.toolIds, ...profile.requestable.toolIds])];
    const rows = ids.length
      ? await this.db
          .select()
          .from(tools)
          .where(and(eq(tools.ownerId, ownerId), inArray(tools.id, ids)))
      : [];
    return this.scopedCatalog(ownerId, rows);
  }
  async describedCatalog(ownerId: string, profileId: string) {
    return describeTools({
      db: this.db,
      profile: await this.owned(ownerId, profileId),
      catalog: await this.catalog(ownerId, profileId),
    });
  }
  async catalog(ownerId: string, profileId?: string, connectionId?: string) {
    const rows = await this.db
      .select()
      .from(tools)
      .where(
        and(
          eq(tools.ownerId, ownerId),
          connectionId ? eq(tools.connectionId, connectionId) : undefined,
        ),
      );
    if (!profileId) return this.scopedCatalog(ownerId, rows);
    const profile = await this.owned(ownerId, profileId);
    const effective = await this.access?.effective({ ownerId, profileId });
    return this.scopedCatalog(
      ownerId,
      rows.filter((tool) => (effective ?? profile).toolIds.includes(tool.id)),
    );
  }
  async tool(ownerId: string, input: { toolId: string; profileId?: string }) {
    if (input.profileId) {
      const profile = await this.owned(ownerId, input.profileId);
      const effective = await this.access?.effective({ ownerId, profileId: input.profileId });
      if (!(effective ?? profile).toolIds.includes(input.toolId)) return undefined;
    }
    const rows = await this.db
      .select()
      .from(tools)
      .where(and(eq(tools.ownerId, ownerId), eq(tools.id, input.toolId)));
    return (await this.scopedCatalog(ownerId, rows))[0];
  }
}
