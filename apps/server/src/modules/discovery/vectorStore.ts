import { and, eq, inArray } from 'drizzle-orm';
import { toolVectors, type Database } from '@platform/db';
export type VectorScope = { ownerId: string; profileId: string; scope: string };
export class VectorStore {
  constructor(private readonly db: Database) {}
  async read(scope: VectorScope, ids: readonly string[]) {
    if (!ids.length) return [];
    return this.db
      .select()
      .from(toolVectors)
      .where(
        and(
          eq(toolVectors.ownerId, scope.ownerId),
          eq(toolVectors.profileId, scope.profileId),
          eq(toolVectors.scope, scope.scope),
          inArray(toolVectors.toolId, [...ids]),
        ),
      );
  }
  async save(
    scope: VectorScope,
    rows: { toolId: string; definitionHash: string; vector: number[] }[],
  ) {
    if (!rows.length) return;
    await this.db.transaction(async (tx) => {
      for (const row of rows)
        await tx
          .insert(toolVectors)
          .values({ ...scope, ...row })
          .onConflictDoUpdate({
            target: [
              toolVectors.ownerId,
              toolVectors.profileId,
              toolVectors.scope,
              toolVectors.toolId,
            ],
            set: { definitionHash: row.definitionHash, vector: row.vector, updatedAt: new Date() },
          });
    });
  }
}
