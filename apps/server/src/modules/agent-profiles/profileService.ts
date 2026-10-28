import type { DiscoveryService } from '../discovery/discoveryService.js';
import type { AccessService } from '../permissions/accessService.js';
import { describeTools } from './toolPresentation.js';
import { describeSharedTools } from './sharedToolPresentation.js';
import { assertDeploymentReady } from '../configuration/readiness.js';
import { activeUser } from '../users/userAccess.js';
import type { ShareService } from '../shares/shareService.js';
import { and, eq, inArray, gt, isNull, or, sql } from 'drizzle-orm';
import {
  profiles,
  artifacts,
  tools,
  mcpEntries,
  accessKeys,
  oauthGrants,
  skillVersions,
  type Database,
} from '@platform/db';
import { catalogOptions, profileInput } from '@platform/contracts';
import { validateCatalogOptions } from '../catalog/validation.js';
import { projectTools } from '../catalog/projection.js';
import { digest, secretToken } from '../../shared/crypto.js';
import { AppError, requireValue } from '../../shared/errors.js';
export type Principal = { ownerId: string; profileId: string; credentialId: string; token: string };
import type { ConnectionService } from '../mcp/connectionService.js';
export class ProfileService {
  access?: AccessService;
  discovery!: DiscoveryService;
  constructor(
    private readonly db: Database,
    private readonly connections: ConnectionService,
    private readonly shares: ShareService,
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
            catalog: previous.catalog,
            discoveryMode: previous.discoveryMode,
            pinnedTools: previous.pinnedTools,
            embedding: previous.embedding,
            connectionIdentities: previous.connectionIdentities,
            ...(input as object),
          }
        : input,
    );
    if (previous && value.revision !== undefined && value.revision !== previous.revision)
      throw new AppError('REVISION_CONFLICT', '配置已改变，请重新加载', 409);
    if (previous && !Object.hasOwn(input as object, 'pinnedTools'))
      value.pinnedTools = value.pinnedTools.filter((id) => value.toolIds.includes(id));
    if (value.pinnedTools.some((id) => !value.toolIds.includes(id)))
      throw new AppError('DISCOVERY_PIN', '钉选工具必须包含在 Profile 的工具授权中');
    if (value.discoveryMode === 'search' && !value.embedding)
      throw new AppError('EMBEDDING_CONFIG', '搜索模式需要独立配置 Embedding 服务');
    await this.validateRequestable(ownerId, value);
    await validateCatalogOptions(
      { db: this.db, shares: this.shares, previous: previous?.catalog },
      ownerId,
      value,
    );
    const contentIds = [...new Set(value.contentIds)];
    const entries = contentIds.length
      ? await this.db
          .select()
          .from(mcpEntries)
          .where(
            and(
              await this.shares.resourceFilter(ownerId, 'contentIds'),
              inArray(mcpEntries.id, contentIds),
            ),
          )
      : [];
    if (entries.length !== contentIds.length)
      throw new AppError(
        'INVALID_GRANTS',
        '选择的 Prompt 或 Resource 不属于当前用户或未获共享授权',
      );
    const toolIds = [...new Set(value.toolIds)];
    const versionIds = [...new Set(value.skillVersionIds)];
    const validTools = toolIds.length
      ? await this.db
          .select()
          .from(tools)
          .where(
            and(await this.shares.resourceFilter(ownerId, 'toolIds'), inArray(tools.id, toolIds)),
          )
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
      throw new AppError('INVALID_GRANTS', '选择的工具或 Skill 版本未获授权');
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
            .where(and(await this.shares.resourceFilter(ownerId, kind), inArray(table.id, ids)))
        : [];
      if (rows.length !== ids.length)
        throw new AppError('INVALID_GRANTS', '可申请能力必须属于当前用户或已获共享授权');
    }
    for (const id of Object.keys(value.connectionIdentities ?? {})) {
      await this.shares.connection(ownerId, id);
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
    if (key) {
      await activeUser(this.db, key.ownerId);
      assertDeploymentReady(await this.owned(key.ownerId, profileId));
      return { ownerId: key.ownerId, profileId, credentialId: key.id, token };
    }
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
    if (grant) {
      await activeUser(this.db, grant.ownerId);
      assertDeploymentReady(await this.owned(grant.ownerId, profileId));
      return { ownerId: grant.ownerId, profileId, credentialId: grant.id, token };
    }
    throw new AppError('UNAUTHORIZED', 'Agent 凭证无效、已过期或已撤销', 401);
  }
  private async scopedCatalog(
    ownerId: string,
    rows: (typeof tools.$inferSelect)[],
    cached = false,
  ) {
    const snapshots = new Map(
      await Promise.all(
        [...new Set(rows.map((row) => row.connectionId))].map(async (id) => {
          const snapshot = await (cached
            ? this.connections.catalogForSearch(ownerId, id)
            : this.connections.catalogForAccess(ownerId, id));
          return [id, snapshot] as const;
        }),
      ),
    );
    const permitted = new Set(
      await this.shares.permitted(
        ownerId,
        'toolIds',
        rows.map((row) => row.id),
      ),
    );
    return rows
      .filter((row) => permitted.has(row.id))
      .flatMap((row) => {
        const definition = snapshots
          .get(row.connectionId)
          ?.tools.find((tool) => tool.name === row.name);
        return definition ? [{ ...row, definition }] : [];
      });
  }
  async instructions(ownerId: string, profileId: string) {
    const profile = await this.owned(ownerId, profileId);
    if (profile.discoveryMode === 'search') return profile.instructions;
    const catalog = await this.catalog(ownerId, profileId);
    const content = profile.contentIds.length
      ? await this.db
          .select({ connectionId: mcpEntries.connectionId })
          .from(mcpEntries)
          .where(
            and(
              await this.shares.resourceFilter(ownerId, 'contentIds'),
              inArray(mcpEntries.id, profile.contentIds),
            ),
          )
      : [];
    const ids = [...new Set([...catalog, ...content].map((row) => row.connectionId))].sort();
    const descriptions = await Promise.all(
      ids.map(async (id) => {
        const row = await this.connections.accessible(ownerId, id);
        const snapshot = await this.connections?.catalogForAccess(ownerId, id);
        const text = snapshot?.instructions;
        return text ? `[${row?.name ?? id} · ${id}]\n${text}` : '';
      }),
    );
    return [profile.instructions, ...descriptions].filter(Boolean).join('\n\n');
  }
  async potentialCatalog(ownerId: string, profileId: string) {
    const profile = await this.owned(ownerId, profileId);
    assertDeploymentReady(profile);
    const ids = [...new Set([...profile.toolIds, ...profile.requestable.toolIds])];
    const rows = ids.length
      ? await this.db
          .select()
          .from(tools)
          .where(and(await this.shares.resourceFilter(ownerId, 'toolIds'), inArray(tools.id, ids)))
      : [];
    return projectTools(await this.presentedCatalog(ownerId, profileId, rows), profile.catalog);
  }
  async hasArtifactOutputs(ownerId: string, profileId: string) {
    const profile = await this.owned(ownerId, profileId);
    assertDeploymentReady(profile);
    const ids = [...new Set([...profile.toolIds, ...profile.requestable.toolIds])];
    if (!ids.length) return false;
    // Inspect configured sources only: catalog discovery would wake sleeping search connections.
    const rows = await this.db
      .select({ connectionId: tools.connectionId })
      .from(tools)
      .where(and(await this.shares.resourceFilter(ownerId, 'toolIds'), inArray(tools.id, ids)));
    for (const id of new Set(rows.map((row) => row.connectionId))) {
      const context = await this.connections?.context(ownerId, id);
      if (context?.config.source === 'openapi') return true;
    }
    return false;
  }
  describedCatalog(ownerId: string, profileId: string) {
    return this.catalog(ownerId, profileId);
  }
  private async presentedCatalog(
    ownerId: string,
    profileId: string | undefined,
    rows: (typeof tools.$inferSelect)[],
  ) {
    return this.describeCatalog(ownerId, profileId, await this.scopedCatalog(ownerId, rows));
  }
  private async describeCatalog(
    ownerId: string,
    profileId: string | undefined,
    catalog: (typeof tools.$inferSelect)[],
  ) {
    if (!profileId) return catalog;
    const [owned, shared] = await Promise.all([
      describeTools({
        db: this.db,
        profile: await this.owned(ownerId, profileId),
        catalog: catalog.filter((tool) => tool.ownerId === ownerId),
      }),
      describeSharedTools({
        ownerId,
        connections: this.connections,
        catalog: catalog.filter((tool) => tool.ownerId !== ownerId),
      }),
    ]);
    const descriptions = new Map([...owned, ...shared].map((tool) => [tool.id, tool]));
    return catalog.map((tool) => descriptions.get(tool.id)!);
  }
  async catalog(ownerId: string, profileId?: string, connectionId?: string) {
    const rows = await this.db
      .select()
      .from(tools)
      .where(
        and(
          await this.shares.resourceFilter(ownerId, 'toolIds'),
          connectionId ? eq(tools.connectionId, connectionId) : undefined,
        ),
      );
    if (!profileId)
      return projectTools(await this.scopedCatalog(ownerId, rows), catalogOptions.parse({}));
    const profile = await this.owned(ownerId, profileId);
    const effective = await this.access?.effective({ ownerId, profileId });
    return projectTools(
      await this.presentedCatalog(
        ownerId,
        profileId,
        rows.filter((tool) => (effective ?? profile).toolIds.includes(tool.id)),
      ),
      profile.catalog,
    );
  }
  async searchCatalog(ownerId: string, profileId: string) {
    const profile = await this.owned(ownerId, profileId);
    assertDeploymentReady(profile);
    const effective = await this.access?.effective({ ownerId, profileId });
    const ids = (effective ?? profile).toolIds;
    const rows = ids.length
      ? await this.db
          .select()
          .from(tools)
          .where(and(await this.shares.resourceFilter(ownerId, 'toolIds'), inArray(tools.id, ids)))
      : [];
    return projectTools(
      await this.describeCatalog(ownerId, profileId, await this.scopedCatalog(ownerId, rows, true)),
      profile.catalog,
    );
  }
  async resolveName(ownerId: string, input: { profileId: string; name: string }) {
    const row = (await this.catalog(ownerId, input.profileId)).find(
      (tool) => tool.exposedName === input.name,
    );
    if (!row) throw new AppError('TOOL_FORBIDDEN', '该工具展示名不存在或未授权', 403);
    return row.id;
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
      .where(and(await this.shares.resourceFilter(ownerId, 'toolIds'), eq(tools.id, input.toolId)));
    const config = input.profileId
      ? (await this.owned(ownerId, input.profileId)).catalog
      : catalogOptions.parse({});
    return projectTools(await this.presentedCatalog(ownerId, input.profileId, rows), config)[0];
  }
}
