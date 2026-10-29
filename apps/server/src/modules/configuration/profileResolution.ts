import type { ManifestProfile, ManifestMappings, CatalogOptions } from '@platform/contracts';
import type { ManifestEntryState } from '@platform/db';
import type { ConnectionService } from '../mcp/connectionService.js';
import { toolId } from '../mcp/catalogRepository.js';
import { catalogEntries } from '../mcp/catalogEntries.js';
import { DeploymentPending, external } from './values.js';
import { mergeTextOptions, mergeToolOptions } from './catalogOverrides.js';

export async function resolveProfile(input: {
  ownerId: string;
  declaration: ManifestProfile;
  mappings: ManifestMappings;
  entries: readonly ManifestEntryState[];
  connections: ConnectionService;
}) {
  const { declaration: value, ownerId, connections } = input;
  const required = new Set(
    [
      ...value.tools,
      ...value.pinnedTools,
      ...value.content,
      ...value.requestable.tools,
      ...value.requestable.content,
    ].map((item) => item.connection),
  );
  for (const name of [
    ...Object.keys(value.connectionAliases),
    ...Object.keys(value.connectionIdentities),
  ])
    required.add(name);
  const sources = new Map(
    await Promise.all(
      [...required].map(async (name) => {
        const entry = input.entries.find(
          (entry) => entry.kind === 'connection' && entry.name === name,
        );
        if (!entry?.objectId || entry.status !== 'ready')
          throw new DeploymentPending(`连接 ${name} 尚未就绪`);
        const context = await connections.context(ownerId, entry.objectId);
        const snapshot = await connections.snapshot(ownerId, entry.objectId);
        if (!snapshot) throw new DeploymentPending(`连接 ${name} 尚无当前身份的真实发现结果`);
        return [
          name,
          { id: entry.objectId, snapshot, content: catalogEntries(context, snapshot) },
        ] as const;
      }),
    ),
  );
  const catalog: CatalogOptions = {
    toolNaming: value.toolNaming,
    connectionAliases: {},
    tools: {},
    content: {},
  };
  const tools = (refs: ManifestProfile['tools']) =>
    refs.map((ref) => {
      const source = sources.get(ref.connection)!;
      if (!source.snapshot.tools.some((tool) => tool.name === ref.name))
        throw new DeploymentPending(`尚未发现工具：${ref.connection}/${ref.name}`);
      const id = toolId(source.id, ref.name);
      catalog.tools[id] = mergeToolOptions(catalog.tools[id], {
        alias: ref.alias,
        description: ref.description,
        hiddenParameters: ref.hiddenParameters,
      });
      return id;
    });
  const content = (refs: ManifestProfile['content']) =>
    refs.map((ref) => {
      const row = sources
        .get(ref.connection)!
        .content.find((entry) => entry.kind === ref.kind && entry.locator === ref.locator);
      if (!row)
        throw new DeploymentPending(`尚未发现 ${ref.kind}：${ref.connection}/${ref.locator}`);
      catalog.content[row.id] = mergeTextOptions(catalog.content[row.id], {
        description: ref.description,
      });
      return row.id;
    });
  for (const [name, alias] of Object.entries(value.connectionAliases))
    catalog.connectionAliases[sources.get(name)!.id] = alias;
  return {
    name: value.name,
    instructions: value.instructions,
    discoveryMode: value.discoveryMode,
    embedding: value.embedding,
    searchOptions: value.searchOptions,
    resultPresentation: value.resultPresentation,
    pinnedTools: value.pinnedTools.map((ref) => toolId(sources.get(ref.connection)!.id, ref.name)),
    toolIds: tools(value.tools),
    contentIds: content(value.content),
    artifactIds: value.artifacts.map((name) => external(input.mappings, 'artifacts', name)),
    skillVersionIds: value.skills.map((name) => external(input.mappings, 'skills', name)),
    requestable: {
      toolIds: tools(value.requestable.tools),
      contentIds: content(value.requestable.content),
      artifactIds: value.requestable.artifacts.map((name) =>
        external(input.mappings, 'artifacts', name),
      ),
    },
    connectionIdentities: Object.fromEntries(
      Object.entries(value.connectionIdentities).map(([name, mode]) => [
        sources.get(name)!.id,
        mode,
      ]),
    ),
    catalog,
  };
}
