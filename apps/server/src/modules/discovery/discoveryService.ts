import { SearchIndexManager, type DiscoveryDependencies } from './searchIndexManager.js';
import { SearchTiming } from './searchTiming.js';
import type { RuntimeMetrics } from '../activity/runtimeMetrics.js';
import { parseTool, type Tool } from '@platform/mcp';
import type { ProfileService } from '../agent-profiles/profileService.js';
import { scopeToolDefinition } from '../mcp/catalogEntries.js';
import { AppError } from '../../shared/errors.js';
import { discoveryTools, searchInput, definitionInput, discoverCallInput } from './tools.js';
type Catalog = Awaited<ReturnType<ProfileService['searchCatalog']>>;
export const toolDefinition = (row: Catalog[number]) =>
  parseTool(scopeToolDefinition(row.connectionId, row.definition));
export class DiscoveryService {
  private readonly indexes: SearchIndexManager;
  constructor(private readonly deps: DiscoveryDependencies & { metrics: RuntimeMetrics }) {
    this.indexes = new SearchIndexManager(deps);
  }
  status(ownerId: string, profileId: string) {
    return this.indexes.status(ownerId, profileId);
  }
  rebuild(ownerId: string, profileId: string) {
    return this.indexes.rebuild(ownerId, profileId);
  }
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
    await this.indexes.enabled(ownerId, input.profileId);
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
      await this.indexes.enabled(ownerId, input.profileId);
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
  async search(ownerId: string, input: { profileId: string; query: string; limit: number }) {
    return (await this.searchDetailed(ownerId, input)).hits;
  }
  async searchDetailed(
    ownerId: string,
    input: { profileId: string; query: string; limit: number },
  ) {
    const timing = new SearchTiming();
    const started = performance.now();
    const profile = await this.deps.profiles.owned(ownerId, input.profileId);
    let status: 'succeeded' | 'failed' = 'failed';
    let strategy = profile.searchOptions.strategy;
    try {
      const result = await this.retrieve(ownerId, input, timing);
      const hits = result.hits;
      strategy = result.strategy;
      status = 'succeeded';
      return {
        hits,
        count: hits.length,
        approximate: strategy === 'hnsw',
        durationMs: performance.now() - started,
        timingsMs: timing.milliseconds,
      };
    } finally {
      this.deps.metrics.search({
        strategy,
        status,
        durationMs: performance.now() - started,
      });
    }
  }
  private async retrieve(
    ownerId: string,
    input: { profileId: string; query: string; limit: number },
    timing: SearchTiming,
  ) {
    const { initial, scope, embed } = await this.indexes.prepare(ownerId, input.profileId, {
      timing,
    });
    const [query] = await embed([input.query]);
    const ids = initial.rows.map((row) => row.id);
    const allowed = new Set(ids);
    const metadata = await timing.measure('index', () => this.deps.vectors.metadata(scope));
    if (metadata.some((row) => allowed.has(row.toolId) && row.dimensions !== query!.length))
      throw new AppError('EMBEDDING_DIMENSIONS', '检索向量维度与目录索引不一致', 409);
    const options = initial.profile.searchOptions;
    const search = { ids, vector: query!, minScore: options.minScore, limit: input.limit };
    if (options.strategy === 'hnsw')
      await this.deps.hnsw.sync({
        ...scope,
        family: initial.family,
        credentialId: initial.credentialId,
        fingerprint: initial.fingerprint,
        dimensions: query!.length,
        options: options.hnsw,
        ids,
      });
    const hits = await timing.measure('retrieval', () =>
      options.strategy === 'exact'
        ? this.deps.vectors.search(scope, search)
        : this.deps.hnsw.search(scope, { ...search, efSearch: options.hnsw.efSearch }),
    );
    const rows = await this.deps.profiles.searchCatalog(
      ownerId,
      input.profileId,
      hits.map((hit) => hit.toolId),
    );
    const byId = new Map(rows.map((row) => [row.id, row]));
    await timing.measure('authorization', () => this.indexes.assertUnchanged(ownerId, initial));
    const result = hits.map((hit) => ({
      ...hit,
      name: byId.get(hit.toolId)!.exposedName,
      description: byId.get(hit.toolId)!.definition.description,
    }));
    await timing.measure('serialization', async () => JSON.stringify(result));
    return { hits: result, strategy: options.strategy };
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
  recover() {
    return this.deps.hnsw.recover();
  }
  invalidateCredential(id: string) {
    return this.deps.hnsw.invalidateCredential(id);
  }
  async close() {
    await this.indexes.close();
  }
}
