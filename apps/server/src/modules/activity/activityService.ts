import { and, count, desc, getTableColumns, isNotNull, lte, notInArray, sql } from 'drizzle-orm';
import { calls, type Database } from '@platform/db';
import { z } from 'zod';
import { AppError, requireValue } from '../../shared/errors.js';
import type { Vault } from '../../shared/crypto.js';
import {
  callWhere,
  decodeCursor,
  durationMs,
  encodeCursor,
  filtersSchema,
  pageSchema,
} from './query.js';

const cleanup = z
  .object({ filters: filtersSchema, preparedAt: z.iso.datetime(), ownerId: z.string() })
  .strict();
export class ActivityService {
  constructor(private readonly deps: { db: Database; vault: Vault }) {}
  async list(ownerId: string, input: Record<string, string>) {
    const { limit: rawLimit, cursor: rawCursor, ...filters } = input;
    const value = filtersSchema.parse(filters);
    const { limit, cursor } = pageSchema.parse({ limit: rawLimit, cursor: rawCursor });
    let decoded;
    try {
      decoded = decodeCursor(cursor);
    } catch {
      throw new AppError('INVALID_CURSOR', '分页游标无效');
    }
    const rows = await this.deps.db
      .select({ ...getTableColumns(calls), cursorAt: sql<string>`${calls.startedAt}::text` })
      .from(calls)
      .where(
        and(
          callWhere(ownerId, value),
          decoded
            ? sql`(${calls.startedAt}, ${calls.id}) < (${decoded.at}::timestamptz, ${decoded.id}::uuid)`
            : undefined,
        ),
      )
      .orderBy(desc(calls.startedAt), desc(calls.id))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    return {
      items: page.map(({ cursorAt: _cursor, ...row }) => row),
      nextCursor: rows.length > limit ? encodeCursor(page.at(-1)!) : null,
    };
  }
  async detail(ownerId: string, id: string) {
    const [row] = await this.deps.db
      .select()
      .from(calls)
      .where(and(callWhere(ownerId, {}), sql`${calls.id} = ${id}::uuid`));
    return requireValue(row);
  }
  async stats(ownerId: string, input: unknown) {
    const filters = filtersSchema.parse(input);
    return this.deps.db
      .select({
        status: calls.status,
        count: count(),
        meanDurationMs: sql<number | null>`avg(${durationMs})::float8`,
        totalDurationMs: sql<number | null>`sum(${durationMs})::float8`,
      })
      .from(calls)
      .where(callWhere(ownerId, filters))
      .groupBy(calls.status);
  }
  private cleanupWhere(input: z.infer<typeof cleanup>) {
    return and(
      callWhere(input.ownerId, input.filters),
      notInArray(calls.status, ['running', 'waiting']),
      isNotNull(calls.endedAt),
      lte(calls.endedAt, new Date(input.preparedAt)),
    );
  }
  async preview(ownerId: string, input: unknown) {
    const value = {
      ownerId,
      filters: filtersSchema.parse(input),
      preparedAt: new Date().toISOString(),
    };
    const [row] = await this.deps.db
      .select({ count: count() })
      .from(calls)
      .where(this.cleanupWhere(value));
    return {
      count: row!.count,
      preparedAt: value.preparedAt,
      token: this.deps.vault.seal(value, `call-cleanup:${ownerId}`),
    };
  }
  async clear(ownerId: string, input: unknown) {
    const { token } = z
      .object({ token: z.string().min(1) })
      .strict()
      .parse(input);
    let value;
    try {
      value = cleanup.parse(this.deps.vault.open(token, `call-cleanup:${ownerId}`));
    } catch {
      throw new AppError('CLEANUP_PREVIEW', '清理预览无效，请重新预览');
    }
    if (value.ownerId !== ownerId) throw new AppError('CLEANUP_PREVIEW', '清理账号不匹配', 403);
    const result = await this.deps.db.delete(calls).where(this.cleanupWhere(value));
    return { deleted: result.rowCount };
  }
}
