import { and, eq, inArray } from 'drizzle-orm';
import { searchCatalogEntries, type Database } from '@platform/db';
import type { McpCatalog } from '@platform/mcp';
import { fingerprint } from '../configuration/values.js';
import type { Vault } from '../../shared/crypto.js';
const BATCH_SIZE = 128;
export class SearchCatalogStore {
  constructor(private readonly deps: { db: Database; vault: Vault }) {}
  async save(
    input: { snapshotId: string; ownerId: string; tools: McpCatalog['tools'] },
    tx: Pick<Database, 'delete' | 'insert'> = this.deps.db,
  ) {
    const rows = input.tools.map((tool) => ({
      snapshotId: input.snapshotId,
      name: tool.name,
      definitionHash: fingerprint(tool),
      encrypted: this.deps.vault.seal(
        tool,
        `search-catalog:${input.ownerId}:${input.snapshotId}:${tool.name}`,
      ),
    }));
    await tx
      .delete(searchCatalogEntries)
      .where(eq(searchCatalogEntries.snapshotId, input.snapshotId));
    for (let offset = 0; offset < rows.length; offset += BATCH_SIZE)
      await tx.insert(searchCatalogEntries).values(rows.slice(offset, offset + BATCH_SIZE));
  }
  metadata(snapshotId: string) {
    return this.deps.db
      .select({
        name: searchCatalogEntries.name,
        definitionHash: searchCatalogEntries.definitionHash,
      })
      .from(searchCatalogEntries)
      .where(eq(searchCatalogEntries.snapshotId, snapshotId));
  }
  async definitions(input: { snapshotId: string; ownerId: string; names: string[] }) {
    if (!input.names.length) return [];
    const rows = await this.deps.db
      .select()
      .from(searchCatalogEntries)
      .where(
        and(
          eq(searchCatalogEntries.snapshotId, input.snapshotId),
          inArray(searchCatalogEntries.name, input.names),
        ),
      );
    return rows.map((row) =>
      this.deps.vault.open<McpCatalog['tools'][number]>(
        row.encrypted,
        `search-catalog:${input.ownerId}:${input.snapshotId}:${row.name}`,
      ),
    );
  }
}
