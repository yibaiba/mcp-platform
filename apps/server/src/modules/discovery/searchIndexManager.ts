import { SearchTiming } from './searchTiming.js';
import type { ProfileService } from '../agent-profiles/profileService.js';
import type { ConnectionService } from '../mcp/connectionService.js';
import type { ConfigSecrets } from '../configuration/secretService.js';
import type { EmbeddingClient } from './embeddingClient.js';
import type { VectorStore } from './vectorStore.js';
import type { HnswStore } from './hnswStore.js';
import { currentExecution } from '../mcp/executionContext.js';
import { fingerprint } from '../configuration/values.js';
import { AppError } from '../../shared/errors.js';
export type DiscoveryDependencies = {
  profiles: ProfileService;
  connections: ConnectionService;
  secrets: ConfigSecrets;
  embeddings: EmbeddingClient;
  vectors: VectorStore;
  hnsw: HnswStore;
};
export class SearchIndexManager {
  private readonly pending = new Map<string, Promise<unknown>>();
  private readonly abort = new AbortController();
  constructor(private readonly deps: DiscoveryDependencies) {}
  async enabled(ownerId: string, profileId: string) {
    await this.deps.profiles.access!.assertSubject({ ownerId, profileId });
    const profile = await this.deps.profiles.owned(ownerId, profileId);
    if (profile.discoveryMode !== 'search' || !profile.embedding)
      throw new AppError('DISCOVERY_DISABLED', '该 Agent 尚未启用语义搜索和 Embedding 配置', 409);
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
      credentialId: currentExecution()?.credentialId,
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
  async prepare(
    ownerId: string,
    profileId: string,
    options: { rebuild?: boolean; timing?: SearchTiming } = {},
  ) {
    const timing = options.timing ?? new SearchTiming();
    const initial = await timing.measure('authorization', () => this.candidate(ownerId, profileId));
    const config = initial.profile.embedding!;
    const apiKey = config.apiKeyRef
      ? await this.deps.secrets.read(ownerId, config.apiKeyRef)
      : undefined;
    const scope = { ownerId, profileId, scope: initial.scope };
    const stored = new Map(
      (await timing.measure('index', () => this.deps.vectors.metadata(scope))).map((row) => [
        row.toolId,
        row,
      ]),
    );
    const missing = initial.entries.filter(
      ({ row, definitionHash }) =>
        options.rebuild || stored.get(row.id)?.definitionHash !== definitionHash,
    );
    const key = initial.fingerprint;
    if (this.pending.has(key))
      throw new AppError('SEARCH_INDEX_PENDING', '当前身份的工具索引正在更新，请稍后重试', 409);
    const embed = (texts: string[]) =>
      timing.measure('embedding', () =>
        this.deps.embeddings.embed({ config, apiKey, texts, signal: this.abort.signal }),
      );
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
    await timing.measure('authorization', () => this.assertUnchanged(ownerId, initial));
    return { initial, scope, embed };
  }
  async assertUnchanged(
    ownerId: string,
    initial: Awaited<ReturnType<SearchIndexManager['candidate']>>,
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
    const { initial, scope } = await this.prepare(ownerId, profileId, { rebuild: true });
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
        credentialId: initial.credentialId,
        fingerprint: initial.fingerprint,
        dimensions,
        ids: initial.rows.map((row) => row.id),
        options: initial.profile.searchOptions.hnsw,
      });
    }
    await this.assertUnchanged(ownerId, initial);
    return this.status(ownerId, profileId);
  }
  async close() {
    this.abort.abort();
    await Promise.allSettled([...this.pending.values()]);
  }
}
