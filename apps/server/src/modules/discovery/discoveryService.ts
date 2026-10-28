import { parseTool, type Tool } from '@platform/mcp';
import type { ProfileService } from '../agent-profiles/profileService.js';
import type { ConnectionService } from '../mcp/connectionService.js';
import type { ConfigSecrets } from '../configuration/secretService.js';
import { currentExecution } from '../mcp/executionContext.js';
import { scopeToolDefinition } from '../mcp/catalogEntries.js';
import { fingerprint } from '../configuration/values.js';
import { AppError } from '../../shared/errors.js';
import { discoveryTools, searchInput, definitionInput, discoverCallInput } from './tools.js';
import { cosine, type EmbeddingClient } from './embeddingClient.js';
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
    const row = (await this.deps.profiles.searchCatalog(ownerId, input.profileId)).find(
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
    const rows = (await this.deps.profiles.searchCatalog(ownerId, profileId)).sort((a, b) =>
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
    const scope = fingerprint({
      ownerId,
      profileId,
      identity: currentExecution()?.credentialId ?? currentExecution()?.identity ?? 'dashboard',
      contexts,
      embedding: profile.embedding,
      secretRevision,
    });
    const entries = rows.map((row) => ({ row, definitionHash: fingerprint(row.definition) }));
    return {
      profile,
      rows,
      entries,
      scope,
      fingerprint: fingerprint({
        scope,
        entries: entries.map(({ row, definitionHash }) => [row.id, definitionHash]),
      }),
    };
  }
  async search(ownerId: string, input: { profileId: string; query: string; limit: number }) {
    const initial = await this.candidate(ownerId, input.profileId);
    const config = initial.profile.embedding!;
    const apiKey = config.apiKeyRef
      ? await this.deps.secrets.read(ownerId, config.apiKeyRef)
      : undefined;
    const scope = { ownerId, profileId: input.profileId, scope: initial.scope };
    const stored = new Map(
      (
        await this.deps.vectors.read(
          scope,
          initial.rows.map((row) => row.id),
        )
      ).map((row) => [row.toolId, row]),
    );
    const missing = initial.entries.filter(
      ({ row, definitionHash }) => stored.get(row.id)?.definitionHash !== definitionHash,
    );
    const key = initial.fingerprint;
    if (this.pending.has(key))
      throw new AppError('SEARCH_INDEX_PENDING', '当前身份的工具索引正在更新，请稍后重试', 409);
    const embed = (texts: string[]) =>
      this.deps.embeddings.embed({ config, apiKey, texts, signal: this.abort.signal });
    const build = async () => {
      for (let offset = 0; offset < missing.length; offset += config.batchSize) {
        const batch = missing.slice(offset, offset + config.batchSize);
        const vectors = await embed(batch.map(({ row }) => JSON.stringify(row.definition)));
        const entries = batch.map(({ row, definitionHash }, index) => ({
          toolId: row.id,
          definitionHash,
          vector: vectors[index]!,
        }));
        await this.deps.vectors.save(scope, entries);
        for (const entry of entries)
          stored.set(entry.toolId, { ...scope, ...entry, updatedAt: new Date() });
      }
    };
    const work = build();
    this.pending.set(key, work);
    try {
      await work;
    } finally {
      this.pending.delete(key);
    }
    const [query] = await embed([input.query]);
    if ((await this.candidate(ownerId, input.profileId)).fingerprint !== initial.fingerprint)
      throw new AppError('SEARCH_INDEX_CHANGED', '检索期间权限、身份或目录已改变，请重新查询', 409);
    return initial.rows
      .map((row) => ({
        toolId: row.id,
        name: row.exposedName,
        description: row.definition.description,
        score: cosine(query!, stored.get(row.id)!.vector),
      }))
      .sort((a, b) => b.score - a.score || a.toolId.localeCompare(b.toolId))
      .slice(0, input.limit);
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
