import { and, eq, isNull, ne, or, sql } from 'drizzle-orm';
import { searchIndexes, type Database } from '@platform/db';
import type { SearchOptions } from '@platform/contracts';
import { AppError } from '../../shared/errors.js';
import type { VectorScope, VectorQuery } from './vectorStore.js';
const MAX_DIMENSIONS = 2000;
type IndexInput = VectorScope & {
  family: string;
  fingerprint: string;
  dimensions: number;
  options: SearchOptions['hnsw'];
  ids: string[];
};
// Physical identifiers originate only from database-generated UUIDs, never from caller input.
const table = (id: string) => sql.identifier(`search_hnsw_${id.replaceAll('-', '')}`);
export class HnswStore {
  constructor(private readonly db: Database) {}
  async status(scope: VectorScope) {
    const [row] = await this.db
      .select()
      .from(searchIndexes)
      .where(
        and(
          eq(searchIndexes.ownerId, scope.ownerId),
          eq(searchIndexes.profileId, scope.profileId),
          eq(searchIndexes.scope, scope.scope),
        ),
      );
    return row;
  }
  async sync(input: IndexInput) {
    if (input.dimensions > MAX_DIMENSIONS)
      throw new AppError(
        'HNSW_DIMENSIONS',
        'HNSW vector 索引最多支持 2000 维；精确模式不受此限制',
        409,
      );
    await this.cleanup(input);
    const existing = await this.status(input);
    if (!existing)
      throw new AppError(
        'SEARCH_INDEX_MISSING',
        'HNSW 索引尚未创建，请显式重建当前身份的索引',
        409,
      );
    if (existing.state !== 'ready')
      throw new AppError(
        'SEARCH_INDEX_NOT_READY',
        `HNSW 索引状态：${existing.state}；${existing.error ?? '等待重建完成'}`,
        409,
      );
    if (existing.fingerprint !== input.fingerprint) await this.build(input);
  }
  async build(input: IndexInput) {
    if (input.dimensions > MAX_DIMENSIONS || input.dimensions < 1)
      throw new AppError('HNSW_DIMENSIONS', 'HNSW vector 索引需要 1 至 2000 维向量', 409);
    await this.cleanup(input);
    const [record] = await this.db
      .insert(searchIndexes)
      .values({ ...input, state: 'building' })
      .onConflictDoUpdate({
        target: searchIndexes.scope,
        set: { state: 'building', error: null, updatedAt: new Date() },
      })
      .returning();
    const id = record!.id;
    try {
      await this.db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${input.scope}, 0))`);
        await tx.execute(sql`drop table if exists ${table(id)}`);
        await tx.execute(
          sql`create table ${table(id)} (tool_id text primary key, embedding vector(${sql.raw(String(input.dimensions))}) not null)`,
        );
        await tx.execute(sql`insert into ${table(id)} select tool_id, vector::vector from tool_vectors
          where owner_id = ${input.ownerId} and profile_id = ${input.profileId} and scope = ${input.scope}
          and tool_id = any(${sql.param(input.ids)}::text[])`);
        await tx.execute(sql`create index on ${table(id)} using hnsw (embedding vector_cosine_ops)
          with (m = ${sql.raw(String(input.options.m))}, ef_construction = ${sql.raw(String(input.options.efConstruction))})`);
        await tx.execute(sql`analyze ${table(id)}`);
        await tx
          .update(searchIndexes)
          .set({
            state: 'ready',
            fingerprint: input.fingerprint,
            dimensions: input.dimensions,
            updatedAt: new Date(),
          })
          .where(eq(searchIndexes.id, id));
      });
    } catch (error) {
      await this.db
        .update(searchIndexes)
        .set({
          state: 'failed',
          error: '索引创建失败；请检查 pgvector 扩展、数据库资源和服务日志后显式重建',
          updatedAt: new Date(),
        })
        .where(eq(searchIndexes.id, id));
      throw error;
    }
  }
  async search(scope: VectorScope, input: VectorQuery & { efSearch: number }) {
    const record = await this.status(scope);
    if (!record || record.state !== 'ready')
      throw new AppError('SEARCH_INDEX_NOT_READY', 'HNSW 索引尚未就绪', 409);
    if (record.dimensions !== input.vector.length)
      throw new AppError('EMBEDDING_DIMENSIONS', '检索向量维度与目录索引不一致', 409);
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('hnsw.ef_search', ${String(input.efSearch)}, true),
        set_config('hnsw.iterative_scan', 'strict_order', true), set_config('enable_seqscan', 'off', true)`);
      const query = JSON.stringify(input.vector);
      const result = await tx.execute<{ toolId: string; score: number }>(sql`
        with hits as materialized (
          select tool_id, embedding <=> ${query}::vector as distance from ${table(record.id)}
          where tool_id = any(${sql.param(input.ids)}::text[])
          and (${input.minScore}::float8 is null or 1 - (embedding <=> ${query}::vector) >= ${input.minScore}::float8)
          order by embedding <=> ${query}::vector limit ${input.limit}
        ) select tool_id as "toolId", greatest(-1::float8, least(1::float8, 1 - distance)) as score
        from hits order by distance, tool_id collate "C"`);
      return result.rows;
    });
  }
  async cleanup(input: { family: string; scope: string }) {
    const stale = await this.db
      .select()
      .from(searchIndexes)
      .where(
        or(
          isNull(searchIndexes.ownerId),
          isNull(searchIndexes.profileId),
          and(eq(searchIndexes.family, input.family), ne(searchIndexes.scope, input.scope)),
        ),
      );
    for (const row of stale) {
      await this.db
        .update(searchIndexes)
        .set({ state: 'cleaning' })
        .where(eq(searchIndexes.id, row.id));
      await this.db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${row.scope}, 0))`);
        await tx.execute(sql`drop table if exists ${table(row.id)}`);
        await tx.delete(searchIndexes).where(eq(searchIndexes.id, row.id));
        await tx.execute(sql`delete from tool_vectors where scope = ${row.scope}`);
      });
    }
  }
}
