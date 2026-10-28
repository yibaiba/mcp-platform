import { and, eq, inArray } from 'drizzle-orm';
import { artifacts, type Database } from '@platform/db';
import type { ProfileService } from '../agent-profiles/profileService.js';
import type { ConnectionService } from '../mcp/connectionService.js';
import type { ContentService } from '../mcp/contentService.js';
import type { Access } from './accessService.js';

export async function requestCatalog(
  deps: {
    db: Database;
    profiles: ProfileService;
    connections: ConnectionService;
    content: ContentService;
  },
  access: Access,
) {
  const profile = await deps.profiles.owned(access.ownerId, access.profileId!);
  const tools = (await deps.profiles.potentialCatalog(access.ownerId, profile.id))
    .filter((tool) => profile.requestable.toolIds.includes(tool.id))
    .filter((tool) => {
      const ui = (tool.definition._meta as { ui?: { visibility?: string[] } } | undefined)?.ui;
      return !ui?.visibility || ui.visibility.includes('model');
    });
  const content = await deps.content.requestableCatalog(access);
  const files = profile.requestable.artifactIds.length
    ? await deps.db
        .select({ id: artifacts.id, name: artifacts.name, sha256: artifacts.sha256 })
        .from(artifacts)
        .where(
          and(
            eq(artifacts.ownerId, access.ownerId),
            inArray(artifacts.id, profile.requestable.artifactIds),
          ),
        )
    : [];
  const connections = await Promise.all(
    [...new Set([...tools, ...content].map((row) => row.connectionId))].map(async (id) => {
      const row = await deps.connections.accessible(access.ownerId, id);
      const context = await deps.connections.context(access.ownerId, id);
      return {
        id,
        name: row.name,
        adapter: context.config.adapter,
        bindingId: context.bindingId,
        identity: context.identity,
      };
    }),
  );
  return {
    toolIds: tools.map((tool) => tool.id),
    contentIds: content.map((entry) => entry.id),
    artifactIds: files.map((file) => file.id),
    entries: {
      tools: tools.map((tool) => ({
        id: tool.id,
        connectionId: tool.connectionId,
        name: tool.name,
        description: tool.definition.description,
      })),
      content: content.map((entry) => ({
        id: entry.id,
        connectionId: entry.connectionId,
        kind: entry.kind,
        ...deps.content.definition(entry),
      })),
      artifacts: files,
      connections,
    },
  };
}
