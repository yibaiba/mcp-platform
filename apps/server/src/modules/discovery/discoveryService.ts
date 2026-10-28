import type { HnswStore } from './hnswStore.js';
import { parseTool, type Tool } from '@platform/mcp';
import type { ProfileService } from '../agent-profiles/profileService.js';
import type { ConnectionService } from '../mcp/connectionService.js';
import type { ConfigSecrets } from '../configuration/secretService.js';
import { currentExecution } from '../mcp/executionContext.js';
import { scopeToolDefinition } from '../mcp/catalogEntries.js';
import { fingerprint } from '../configuration/values.js';
import { AppError } from '../../shared/errors.js';
import { discoveryTools, searchInput, definitionInput, discoverCallInput } from './tools.js';
import { type EmbeddingClient } from './embeddingClient.js';
import type { VectorStore } from './vectorStore.js';
type Catalog = Awaited<ReturnType<ProfileService['searchCatalog']>>;
export const toolDefinition = (row: Catalog[number]) =>
  parseTool(scopeToolDefinition(row.connectionId, row.definition));
export class DiscoveryService {
  private readonly pending = new Map<string, Promise<unknown>>();
  private readonly abort = new AbortController();
  constructor(
    private readonly deps: {
      profiles: ProfileService;
      connections: ConnectionService;
      secrets: ConfigSecrets;
      embeddings: EmbeddingClient;
      vectors: VectorStore;
      hnsw: HnswStore;
    },
  ) {}
  async exposed(ownerId: string, profileId: string, potential = false): Promise<Tool[]> {
    const profile = await this.deps.profiles.owned(ownerId, profileId);
    if (profile.discoveryMode === 'direct') {
      const rows = potential
        ? await this.deps.profiles.potentialCatalog(ownerId, profileId)
        : await this.deps.profiles.catalog(ownerId, profileId);
      return rows.map(toolDefinition);
    }
    await this.deps.profiles.access!.effective({ ownerId, profileId });
    if (!profile.pinnedTools.length) return discoveryTools;
    const rows = await this.deps.profiles.searchCatalog(ownerId, profileId);
    return [
      ...discoveryTools,
      ...rows.filter((row) => profile.pinnedTools.includes(row.id)).map(toolDefinition),
    ];
  }
  async read(ownerId: string, input: { profileId: string; name: string; arguments: unknown }) {
    if (!['platform_tools_search', 'platform_tools_definition'].includes(input.name))
      return undefined;
    await this.enabled(ownerId, input.profileId);
    if (input.name === 'platform_tools_search')
      return this.search(ownerId, {
        profileId: input.profileId,
        ...searchInput.parse(input.arguments),
      });
    const { toolId } = definitionInput.parse(input.arguments);
    const row = (await this.deps.profiles.searchCatalog(ownerId, input.profileId, [toolId])).find(
      (row) => row.id === toolId,
    );
    if (!row) throw new AppError('TOOL_FORBIDDEN', '工具不存在或当前身份未获授权', 403);
    return { toolId, definition: toolDefinition(row) };
  }
  async resolveCall(
    ownerId: string,
    input: { profileId: string; name: string; arguments: Record<string, unknown> },
  ) {
    const profile = await this.deps.profiles.owned(ownerId, input.profileId);
    if (input.name === 'platform_tools_call') {
      await this.enabled(ownerId, input.profileId);
      const value = discoverCallInput.parse(input.arguments);
      await this.deps.profiles.access!.assert(
        { ownerId, profileId: input.profileId },
        'toolIds',
        value.toolId,
      );
      return value;
    }
    const toolId = await this.deps.profiles.resolveName(ownerId, input);
    if (profile.discoveryMode === 'search' && !profile.pinnedTools.includes(toolId))
      throw new AppError(
        'DISCOVERY_CALL',
        '搜索模式请使用 platform_tools_call 调用未钉选工具',
        400,
      );
    return { toolId, arguments: input.arguments };
  }
  private async enabled(ownerId: string, profileId: string) {
    await this.deps.profiles.access!.effective({ ownerId, profileId });
    const profile = await this.deps.profiles.owned(ownerId, profileId);
    if (profile.discoveryMode !== 'search' || !profile.embedding)
      throw new AppError('DISCOVERY_DISABLED', '该 Profile 尚未启用语义搜索和 Embedding 配置', 409);
    return profile;
  }
  private async candidate(ownerId: string, profileId: string) {
    const profile = await this.enabled(ownerId, profileId);
    const rows = (await this.deps.profiles.searchMetadata(ownerId, profileId)).sort((a, b) =>
      a.id.localeCompare(b.id),
    );
    const contexts = await Promise.all(
      [...new Set(rows.map((row) => row.connectionId))].sort().map(async (id) => {
        const context = await this.deps.connections.context(ownerId, id);
        const binding = await this.deps.connections.bindings.owned(ownerId, context.bindingId!);
        return {
          id,
          revision: context.revision,
          binding: binding.id,
          bindingRevision: binding.revision,
          capabilities: context.capabilityKey,
          shareVersion: context.shareVersion,
        };
      }),
    );
    const secret = profile.embedding!.apiKeyRef;
    const secretRevision = secret
      ? (await this.deps.secrets.list(ownerId)).find((row) => row.name === secret)?.revision
      : undefined;
    const family = fingerprint({
      ownerId,
      profileId,
      identity: currentExecution()?.credentialId ?? currentExecution()?.identity ?? 'dashboard',
      capabilities: currentExecution()?.capabilities,
    });
    const scope = fingerprint({
      ownerId,
      profileId,
      identity: currentExecution()?.credentialId ?? currentExecution()?.identity ?? 'dashboard',
      contexts,
      embedding: profile.embedding,
      secretRevision,
      indexOptions: profile.searchOptions.hnsw,
    });
    const entries = rows.map((row) => ({ row, definitionHash: row.definitionHash }));
    return {
      profile,
      family,
      rows,
      entries,
      scope,
      fingerprint: fingerprint({
        scope,
        revision: profile.revision,
        entries: entries.map(({ row, definitionHash }) => [row.id, definitionHash]),
      }),
    };
  }
  private async index(ownerId: string, profileId: string, rebuild = false) {
    const initial = await this.candidate(ownerId, profileId);
    const config = initial.profile.embedding!;
    const apiKey = config.apiKeyRef
      ? await this.deps.secrets.read(ownerId, config.apiKeyRef)
      : undefined;
    const scope = { ownerId, profileId, scope: initial.scope };
    const stored = new Map(
      (await this.deps.vectors.metadata(scope)).map((row) => [row.toolId, row]),
    );
    const missing = initial.entries.filter(
      ({ row, definitionHash }) => rebuild || stored.get(row.id)?.definitionHash !== definitionHash,
    );
    const key = initial.fingerprint;
    if (this.pending.has(key))
      throw new AppError('SEARCH_INDEX_PENDING', '当前身份的工具索引正在更新，请稍后重试', 409);
    const embed = (texts: string[]) =>
      this.deps.embeddings.embed({ config, apiKey, texts, signal: this.abort.signal });
    const build = async () => {
      for (let offset = 0; offset < missing.length; offset += config.batchSize) {
        const batch = missing.slice(offset, offset + config.batchSize);
        const definitions = await this.deps.profiles.searchCatalog(
          ownerId,
          profileId,
          batch.map(({ row }) => row.id),
        );
        const byId = new Map(definitions.map((row) => [row.id, row.definition]));
        if (batch.some(({ row }) => !byId.has(row.id)))
          throw new AppError('SEARCH_INDEX_CHANGED', '索引期间目录权限已改变', 409);
        const vectors = await embed(batch.map(({ row }) => JSON.stringify(byId.get(row.id))));
        await this.deps.vectors.save(
          scope,
          batch.map(({ row, definitionHash }, index) => ({
            toolId: row.id,
            definitionHash,
            vector: vectors[index]!,
          })),
        );
      }
    };
    const work = build();
    this.pending.set(key, work);
    try {
      await work;
    } finally {
      this.pending.delete(key);
    }
    await this.assertUnchanged(ownerId, initial);
    return { initial, scope, embed };
  }
  private async assertUnchanged(
    ownerId: string,
    initial: Awaited<ReturnType<DiscoveryService['candidate']>>,
  ) {
    if ((await this.candidate(ownerId, initial.profile.id)).fingerprint !== initial.fingerprint)
      throw new AppError('SEARCH_INDEX_CHANGED', '检索期间权限、身份或目录已改变，请重新查询', 409);
  }
  async status(ownerId: string, profileId: string) {
    const initial = await this.candidate(ownerId, profileId);
    const scope = { ownerId, profileId, scope: initial.scope };
    const metadata = await this.deps.vectors.metadata(scope);
    const hashes = new Map(metadata.map((row) => [row.toolId, row.definitionHash]));
    const indexed = initial.rows.filter((row) => hashes.get(row.id) === row.definitionHash).length;
    return {
      strategy: initial.profile.searchOptions.strategy,
      scope: initial.scope,
      tools: initial.rows.length,
      indexed,
      hnsw: (await this.deps.hnsw.status(scope)) ?? { state: 'missing' },
    };
  }
  async rebuild(ownerId: string, profileId: string) {
    const { initial, scope } = await this.index(ownerId, profileId, true);
    if (initial.profile.searchOptions.strategy === 'hnsw') {
      const metadata = await this.deps.vectors.metadata(scope);
      const dimensions = metadata[0]?.dimensions ?? initial.profile.embedding!.dimensions;
      if (!dimensions)
        throw new AppError(
          'HNSW_DIMENSIONS',
          '空目录需要显式配置模型维度后才能建立 HNSW 索引',
          409,
        );
      await this.deps.hnsw.build({
        ...scope,
        family: initial.family,
        fingerprint: initial.fingerprint,
        dimensions,
        ids: initial.rows.map((row) => row.id),
        options: initial.profile.searchOptions.hnsw,
      });
    }
    await this.assertUnchanged(ownerId, initial);
    return this.status(ownerId, profileId);
  }
  async search(ownerId: string, input: { profileId: string; query: string; limit: number }) {
    const { initial, scope, embed } = await this.index(ownerId, input.profileId);
    const [query] = await embed([input.query]);
    const ids = initial.rows.map((row) => row.id);
    const allowed = new Set(ids);
    const metadata = await this.deps.vectors.metadata(scope);
    if (metadata.some((row) => allowed.has(row.toolId) && row.dimensions !== query!.length))
      throw new AppError('EMBEDDING_DIMENSIONS', '检索向量维度与目录索引不一致', 409);
    const options = initial.profile.searchOptions;
    const search = { ids, vector: query!, minScore: options.minScore, limit: input.limit };
    if (options.strategy === 'hnsw')
      await this.deps.hnsw.sync({
        ...scope,
        family: initial.family,
        fingerprint: initial.fingerprint,
        dimensions: query!.length,
        options: options.hnsw,
        ids,
      });
    const hits =
      options.strategy === 'exact'
        ? await this.deps.vectors.search(scope, search)
        : await this.deps.hnsw.search(scope, { ...search, efSearch: options.hnsw.efSearch });
    const rows = await this.deps.profiles.searchCatalog(
      ownerId,
      input.profileId,
      hits.map((hit) => hit.toolId),
    );
    const byId = new Map(rows.map((row) => [row.id, row]));
    await this.assertUnchanged(ownerId, initial);
    return hits.map((hit) => ({
      ...hit,
      name: byId.get(hit.toolId)!.exposedName,
      description: byId.get(hit.toolId)!.definition.description,
    }));
  }
  async footprint(ownerId: string, input: { profileId: string; extra: Tool[] }) {
    const { encode } = await import('gpt-tokenizer/encoding/o200k_base');
    const rows = await this.deps.profiles.searchCatalog(ownerId, input.profileId);
    const exposed = [...input.extra, ...(await this.exposed(ownerId, input.profileId))];
    const full = [...input.extra, ...rows.map(toolDefinition)];
    return {
      encoding: 'o200k_base',
      estimated: true,
      billing: false,
      full: { tools: full.length, tokens: encode(JSON.stringify(full)).length },
      exposed: { tools: exposed.length, tokens: encode(JSON.stringify(exposed)).length },
    };
  }
  async close() {
    this.abort.abort();
    await Promise.allSettled([...this.pending.values()]);
  }
}
