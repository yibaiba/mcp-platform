import { and, eq } from 'drizzle-orm';
import { connections, tools, mcpEntries, connectionShares, type Database } from '@platform/db';
import type { McpCatalog } from '@platform/mcp';
import { digest } from '../../shared/crypto.js';
import type { BindingService } from '../authorizations/bindingService.js';
import type { ConnectionContext } from './adapter.js';
import { catalogEntries } from './catalogEntries.js';
export const toolId = (connectionId: string, name: string) =>
  `t_${digest(`${connectionId}:${name}`)}`;
export class CatalogRepository {
  constructor(
    private readonly db: Database,
    private readonly bindings: BindingService,
  ) {}
  async save(context: ConnectionContext, catalog: McpCatalog) {
    await this.bindings.save(context, catalog);
    if (context.shareId) {
      await this.db
        .update(connectionShares)
        .set({ status: 'connected', error: null })
        .where(
          and(
            eq(connectionShares.id, context.shareId),
            eq(connectionShares.version, context.shareVersion!),
            eq(connectionShares.revoked, false),
          ),
        );
      return;
    }
    await this.db.transaction(async (tx) => {
      if (context.identity === 'default')
        await tx.update(tools).set({ available: false }).where(eq(tools.connectionId, context.id));
      for (const tool of catalog.tools) {
        const row = {
          id: toolId(context.id, tool.name),
          ownerId: context.ownerId,
          connectionId: context.id,
          name: tool.name,
          definition: tool,
          available: true,
        };
        await tx
          .insert(tools)
          .values(row)
          .onConflictDoUpdate({
            target: tools.id,
            set:
              context.identity === 'default'
                ? { definition: tool, available: true }
                : { id: toolId(context.id, tool.name) },
          });
      }
      if (context.identity === 'default')
        await tx
          .update(mcpEntries)
          .set({ available: false })
          .where(eq(mcpEntries.connectionId, context.id));
      for (const row of catalogEntries(context, catalog)) {
        await tx
          .insert(mcpEntries)
          .values(row)
          .onConflictDoUpdate({
            target: mcpEntries.id,
            set:
              context.identity === 'default'
                ? {
                    definition: row.definition,
                    name: row.name,
                    locator: row.locator,
                    available: true,
                  }
                : { id: row.id },
          });
      }
      await tx
        .update(connections)
        .set({
          status: 'connected',
          error: null,
          protocolVersion: catalog.protocolVersion,
          capabilities: catalog.capabilities,
          ...(context.identity === 'default'
            ? { serverInfo: catalog.serverInfo, instructions: catalog.instructions }
            : {}),
        })
        .where(eq(connections.id, context.id));
    });
  }
}
