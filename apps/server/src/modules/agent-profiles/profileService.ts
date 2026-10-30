import { searchCatalogMetadata } from './searchCatalogMetadata.js';
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
  connections,
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
import { legacyToolName } from '../catalog/toolNames.js';
import { digest, secretToken } from '../../shared/crypto.js';
import { AppError, requireValue } from '../../shared/errors.js';
export type Principal = { ownerId: string; profileId: string; credentialId: string; token: string };
import type { ConnectionService, ConnectionUnavailable } from '../mcp/connectionService.js';
/** Set on catalog rows whose connection or device is down; their tools are not listed to Agents. */
export type ToolUnavailable = { code: string; message: string };
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
            searchOptions: previous.searchOptions,
            resultPresentation: previous.resultPresentation,
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
    if (value.searchOptions.strategy === 'hnsw' && (value.embedding?.dimensions ?? 0) > 2000)
      throw new AppError('HNSW_DIMENSIONS', 'HNSW vector 索引最多支持 2000 维；请使用精确检索');
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
    return this.db.transaction(async (tx) => {
      const connectionIds = [
        ...new Set([
          ...Object.keys(value.catalog.connectionAliases),
          ...Object.keys(value.connectionIdentities ?? {}),
        ]),
      ];
      if (connectionIds.length) {
        const locked = await tx
          .select({ id: connections.id })
          .from(connections)
          .where(inArray(connections.id, connectionIds))
          .orderBy(connections.id)
          .for('key share');
        if (locked.length !== connectionIds.length)
          throw new AppError('INVALID_GRANTS', '连接已删除，请重新加载授权目录', 409);
      }
      // Hold content rows until the grant write commits so deletion cannot leave a new dangling grant.
      const required = [...new Set([...contentIds, ...(value.requestable?.contentIds ?? [])])];
      if (required.length) {
        const locked = await tx
          .select({ id: mcpEntries.id })
          .from(mcpEntries)
          .where(inArray(mcpEntries.id, required))
          .orderBy(mcpEntries.id)
          .for('key share');
        if (locked.length !== required.length)
          throw new AppError('INVALID_GRANTS', '内容已删除，请重新加载授权目录', 409);
      }
      const requiredTools = [...new Set([...toolIds, ...(value.requestable?.toolIds ?? [])])];
      if (requiredTools.length) {
        const locked = await tx
          .select({ id: tools.id })
          .from(tools)
          .where(inArray(tools.id, requiredTools))
          .orderBy(tools.id)
          .for('key share');
        if (locked.length !== requiredTools.length)
          throw new AppError('INVALID_GRANTS', '工具已删除，请重新加载授权目录', 409);
      }
      if (id) {
        const [profile] = await tx
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
      const [profile] = await tx
        .insert(profiles)
        .values({ ...value, contentIds, ownerId, toolIds, skillVersionIds: versionIds })
        .returning();
      return profile;
    });
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
  /**
   * Per-connection isolation: a broken upstream or offline device keeps its cached definitions,
   * marked `unavailable`, instead of failing every tool in the Agent.
   */
  private async scopedCatalog(
    ownerId: string,
    rows: (typeof tools.$inferSelect)[],
    cached = false,
  ) {
    type Scope = {
      tools: readonly ({ name: string } & Record<string, unknown>)[];
      unavailable?: ConnectionUnavailable;
    };
    const snapshots = new Map(
      await Promise.all(
        [...new Set(rows.map((row) => row.connectionId))].map(
          async (id): Promise<readonly [string, Scope]> => {
            if (!cached) {
              const { snapshot, unavailable } = await this.connections.catalogOrUnavailable(
                ownerId,
                id,
              );
              return [id, { tools: snapshot?.tools ?? [], unavailable }];
            }
            try {
              const snapshot = await this.searchDefinitions(ownerId, {
                id,
                names: rows.filter((row) => row.connectionId === id).map((row) => row.name),
              });
              return [id, { tools: snapshot.tools }];
            } catch (error) {
              if (!(error instanceof AppError)) throw error;
              return [
                id,
                { tools: [], unavailable: await this.connections.unavailable(ownerId, id, error) },
              ];
            }
          },
        ),
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
        const entry = snapshots.get(row.connectionId);
        const definition = entry?.tools.find((tool) => tool.name === row.name);
        if (!definition) return [];
        const unavailable: ToolUnavailable | undefined = entry?.unavailable
          ? { code: entry.unavailable.code, message: entry.unavailable.message }
          : undefined;
        return [{ ...row, definition: definition as Record<string, unknown>, unavailable }];
      });
  }
  /** Connections whose tools are hidden from tools/list because they cannot run right now. */
  async unavailableConnections(ownerId: string, profileId?: string) {
    const catalog = await this.catalog(ownerId, profileId);
    const seen = new Map<string, { connectionId: string; code: string; message: string }>();
    for (const tool of catalog)
      if (tool.unavailable && !seen.has(tool.connectionId))
        seen.set(tool.connectionId, { connectionId: tool.connectionId, ...tool.unavailable });
    return [...seen.values()];
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
    const down = new Set(
      catalog.filter((tool) => tool.unavailable).map((tool) => tool.connectionId),
    );
    const descriptions = await Promise.all(
      ids.map(async (id) => {
        const row = await this.connections.accessible(ownerId, id);
        // Never fail the handshake: use cached instructions when this connection is down.
        const snapshot = down.has(id)
          ? await this.connections.snapshot(ownerId, id).catch(() => undefined)
          : (await this.connections.catalogOrUnavailable(ownerId, id)).snapshot;
        const text = snapshot?.instructions;
        return text ? `[${row?.name ?? id} · ${id}]\n${text}` : '';
      }),
    );
    return [profile.instructions, ...descriptions].filter(Boolean).join('\n\n');
  }
  /** Projects with connection names so readable tool names are identical on every path. */
  private async project<T extends typeof tools.$inferSelect>(
    rows: readonly T[] | Promise<readonly T[]>,
    config: import('@platform/contracts').CatalogOptions,
    universe?: readonly (typeof tools.$inferSelect)[],
  ) {
    const catalog = await rows;
    const ids = [...new Set([...catalog, ...(universe ?? [])].map((row) => row.connectionId))];
    const names = ids.length
      ? await this.db
          .select({ id: connections.id, name: connections.name })
          .from(connections)
          .where(inArray(connections.id, ids))
      : [];
    return projectTools(
      catalog,
      config,
      new Map(names.map((row) => [row.id, row.name])),
      universe ?? catalog,
    );
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
    return this.project(await this.presentedCatalog(ownerId, profileId, rows), profile.catalog);
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
  private async describeCatalog<T extends typeof tools.$inferSelect>(
    ownerId: string,
    profileId: string | undefined,
    catalog: T[],
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
      return this.project(await this.scopedCatalog(ownerId, rows), catalogOptions.parse({}));
    const profile = await this.owned(ownerId, profileId);
    const effective = await this.access?.effective({ ownerId, profileId });
    const selected = rows.filter((tool) => (effective ?? profile).toolIds.includes(tool.id));
    return this.project(
      await this.presentedCatalog(ownerId, profileId, selected),
      profile.catalog,
      connectionId ? await this.effectiveRows(ownerId, (effective ?? profile).toolIds) : selected,
    );
  }
  private async searchDefinitions(ownerId: string, input: { id: string; names: string[] }) {
    const { metadata } = await this.connections.searchMetadata(ownerId, input.id);
    return {
      tools: metadata
        ? await this.connections.bindings.searchCatalog.definitions({
            snapshotId: metadata.id,
            ownerId,
            names: input.names,
          })
        : [],
    };
  }
  async searchMetadata(ownerId: string, profileId: string) {
    return searchCatalogMetadata(
      {
        db: this.db,
        connections: this.connections,
        access: this.access!,
        shares: this.shares,
        profile: await this.owned(ownerId, profileId),
      },
      ownerId,
    );
  }
  async searchCatalog(ownerId: string, profileId: string, selected?: readonly string[]) {
    const profile = await this.owned(ownerId, profileId);
    assertDeploymentReady(profile);
    const effective = await this.access?.effective({ ownerId, profileId });
    const ids = (effective ?? profile).toolIds.filter((id) => !selected || selected.includes(id));
    const rows = ids.length
      ? await this.db
          .select()
          .from(tools)
          .where(and(await this.shares.resourceFilter(ownerId, 'toolIds'), inArray(tools.id, ids)))
      : [];
    return this.project(
      await this.describeCatalog(ownerId, profileId, await this.scopedCatalog(ownerId, rows, true)),
      profile.catalog,
      // Name against all effective rows, not a `selected` subset, so names match tools/list.
      selected ? await this.effectiveRows(ownerId, (effective ?? profile).toolIds) : rows,
    );
  }
  private async effectiveRows(ownerId: string, ids: readonly string[]) {
    return ids.length
      ? this.db
          .select()
          .from(tools)
          .where(
            and(await this.shares.resourceFilter(ownerId, 'toolIds'), inArray(tools.id, [...ids])),
          )
      : [];
  }
  async resolveName(ownerId: string, input: { profileId: string; name: string }) {
    const catalog = await this.catalog(ownerId, input.profileId);
    const config = (await this.owned(ownerId, input.profileId)).catalog;
    // Legacy `t_<sha256>` names stay callable after readable naming but are no longer listed.
    // Only where the old default exposed them: `stable` naming without an explicit alias.
    const row =
      catalog.find((tool) => tool.exposedName === input.name) ??
      (legacyToolName.test(input.name) && config.toolNaming === 'stable'
        ? catalog.find((tool) => tool.id === input.name && !config.tools[tool.id]?.alias)
        : undefined);
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
    if (!input.profileId)
      return (
        await this.project(
          this.presentedCatalog(ownerId, undefined, rows),
          catalogOptions.parse({}),
        )
      )[0];
    const profile = await this.owned(ownerId, input.profileId);
    const effective = await this.access?.effective({ ownerId, profileId: input.profileId });
    const ids = (effective ?? profile).toolIds;
    // Resolve the readable name against the profile's whole tool set, like tools/list does.
    const universe = await this.effectiveRows(ownerId, ids);
    return (
      await this.project(
        this.presentedCatalog(ownerId, input.profileId, rows),
        profile.catalog,
        universe,
      )
    )[0];
  }
}
