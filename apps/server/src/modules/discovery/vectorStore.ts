import { and, eq, sql } from 'drizzle-orm';
import { toolVectors, type Database } from '@platform/db';
import { AppError } from '../../shared/errors.js';
export type VectorScope = { ownerId: string; profileId: string; scope: string };
export type VectorQuery = {
  ids: string[];
  vector: number[];
  minScore: number | null;
  limit: number;
};
const WRITE_BATCH = 128;
export const vectorFilter = (scope: VectorScope) =>
  and(
    eq(toolVectors.ownerId, scope.ownerId),
    eq(toolVectors.profileId, scope.profileId),
    eq(toolVectors.scope, scope.scope),
  );
export class VectorStore {
  constructor(private readonly db: Database) {}
  async metadata(scope: VectorScope) {
    return this.db
      .select({
        toolId: toolVectors.toolId,
        definitionHash: toolVectors.definitionHash,
        dimensions: sql<number>`cardinality(${toolVectors.vector})`,
      })
      .from(toolVectors)
      .where(vectorFilter(scope));
  }
  async search(scope: VectorScope, input: VectorQuery) {
    if (!input.ids.length) return [];
    const result = await this.db.execute<{ toolId: string; score: number }>(sql`
      with scored as materialized (
        select tool_id, platform_vector_dot(vector, ${sql.param(input.vector)}::float8[]) as score
        from tool_vectors where owner_id = ${scope.ownerId} and profile_id = ${scope.profileId}
          and scope = ${scope.scope} and tool_id = any(${sql.param(input.ids)}::text[])
      ) select tool_id as "toolId", score from scored where ${input.minScore}::float8 is null or score >= ${input.minScore}::float8
      order by score desc, tool_id collate "C" limit ${input.limit}`);
    return result.rows;
  }
  async save(
    scope: VectorScope,
    rows: { toolId: string; definitionHash: string; vector: number[] }[],
  ) {
    for (let offset = 0; offset < rows.length; offset += WRITE_BATCH) {
      const batch = rows.slice(offset, offset + WRITE_BATCH);
      if (batch.some((row) => !row.vector.length || row.vector.some((n) => !Number.isFinite(n))))
        throw new AppError('EMBEDDING_VECTOR', '索引包含无效向量', 502);
      await this.db
        .insert(toolVectors)
        .values(batch.map((row) => ({ ...scope, ...row })))
        .onConflictDoUpdate({
          target: [
            toolVectors.ownerId,
            toolVectors.profileId,
            toolVectors.scope,
            toolVectors.toolId,
          ],
          set: {
            definitionHash: sql`excluded.definition_hash`,
            vector: sql`excluded.vector`,
            updatedAt: new Date(),
          },
        });
    }
  }
  clear(scope: VectorScope) {
    return this.db.delete(toolVectors).where(vectorFilter(scope));
  }
}
