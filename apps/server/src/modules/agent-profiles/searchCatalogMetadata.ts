import { and, eq, sql } from 'drizzle-orm';
import { tools, devices, type Database, type profiles } from '@platform/db';
import type { ConnectionService } from '../mcp/connectionService.js';
import type { AccessService } from '../permissions/accessService.js';
import type { ShareService } from '../shares/shareService.js';
import { assertDeploymentReady } from '../configuration/readiness.js';
import { fingerprint } from '../configuration/values.js';
export async function searchCatalogMetadata(
  deps: {
    db: Database;
    connections: ConnectionService;
    access: AccessService;
    shares: ShareService;
    profile: typeof profiles.$inferSelect;
  },
  ownerId: string,
) {
  const { profile } = deps;
  assertDeploymentReady(profile);
  const effective = await deps.access.effective({ ownerId, profileId: profile.id });
  if (!(effective ?? profile).toolIds.length) return [];
  const rows = await deps.db
    .select({ id: tools.id, connectionId: tools.connectionId, name: tools.name })
    .from(tools)
    .where(
      and(
        await deps.shares.resourceFilter(ownerId, 'toolIds'),
        sql`${tools.id} = any(${sql.param((effective ?? profile).toolIds)}::text[])`,
      ),
    );
  const sources = new Map(
    await Promise.all(
      [...new Set(rows.map((row) => row.connectionId))].map(async (id) => {
        const { metadata, context } = await deps.connections.searchMetadata(ownerId, id);
        const [device] = context.config.deviceId
          ? await deps.db
              .select({ name: devices.name })
              .from(devices)
              .where(and(eq(devices.id, context.config.deviceId), eq(devices.ownerId, ownerId)))
          : [];
        return [
          id,
          {
            entries: new Map(metadata?.entries.map((entry) => [entry.name, entry.definitionHash])),
            source: {
              name: context.config.name,
              device: device?.name,
              deviceId: context.config.deviceId,
              adapter: context.config.adapter,
              identity: profile.connectionIdentities[id],
              delegated: context.credentialScope?.ownerId !== ownerId,
            },
          },
        ] as const;
      }),
    ),
  );
  return rows.flatMap((row) => {
    const source = sources.get(row.connectionId)!;
    const hash = source.entries.get(row.name);
    return hash
      ? [
          {
            ...row,
            definitionHash: fingerprint({
              hash,
              source: source.source,
              naming: profile.catalog.toolNaming,
              alias: profile.catalog.connectionAliases[row.connectionId],
              override: profile.catalog.tools[row.id],
            }),
          },
        ]
      : [];
  });
}
