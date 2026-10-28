import { and, count, desc, eq, getTableColumns, gte, lt, lte, sql } from 'drizzle-orm';
import { systemLogs, type Database } from '@platform/db';
import { z } from 'zod';
import type { Vault } from '../../shared/crypto.js';
import { AppError } from '../../shared/errors.js';
import { adminUser } from '../users/userAccess.js';
import { decodeCursor, encodeCursor, pageSchema } from './query.js';
const filtersSchema = z
  .object({
    from: z.iso.datetime({ offset: true }).optional(),
    before: z.iso.datetime({ offset: true }).optional(),
    level: z.enum(['info', 'warn', 'error']).optional(),
    event: z.string().optional(),
  })
  .strict()
  .refine(
    (value) => !value.from || !value.before || Date.parse(value.from) < Date.parse(value.before),
    '时间范围必须递增',
  );
const cleanup = z.object({ filters: filtersSchema, preparedAt: z.iso.datetime() }).strict();
const where = (value: z.infer<typeof filtersSchema>) =>
  and(
    value.from ? gte(systemLogs.at, new Date(value.from)) : undefined,
    value.before ? lt(systemLogs.at, new Date(value.before)) : undefined,
    value.level ? eq(systemLogs.level, value.level) : undefined,
    value.event ? eq(systemLogs.event, value.event) : undefined,
  );
export class LogService {
  constructor(private readonly deps: { db: Database; vault: Vault }) {}
  async list(ownerId: string, input: Record<string, string>) {
    await adminUser(this.deps.db, ownerId);
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
      .select({ ...getTableColumns(systemLogs), cursorAt: sql<string>`${systemLogs.at}::text` })
      .from(systemLogs)
      .where(
        and(
          where(value),
          decoded
            ? sql`(${systemLogs.at}, ${systemLogs.id}) < (${decoded.at}::timestamptz, ${decoded.id}::uuid)`
            : undefined,
        ),
      )
      .orderBy(desc(systemLogs.at), desc(systemLogs.id))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    return {
      items: page.map(({ cursorAt: _cursor, ...row }) => row),
      nextCursor: rows.length > limit ? encodeCursor(page.at(-1)!) : null,
    };
  }
  async preview(ownerId: string, input: unknown) {
    await adminUser(this.deps.db, ownerId);
    const value = { filters: filtersSchema.parse(input), preparedAt: new Date().toISOString() };
    const [row] = await this.deps.db
      .select({ count: count() })
      .from(systemLogs)
      .where(and(where(value.filters), lte(systemLogs.at, new Date(value.preparedAt))));
    return { count: row!.count, token: this.deps.vault.seal(value, `log-cleanup:${ownerId}`) };
  }
  async clear(ownerId: string, input: unknown) {
    await adminUser(this.deps.db, ownerId);
    const { token } = z.object({ token: z.string() }).strict().parse(input);
    let value;
    try {
      value = cleanup.parse(this.deps.vault.open(token, `log-cleanup:${ownerId}`));
    } catch {
      throw new AppError('CLEANUP_PREVIEW', '清理预览无效，请重新预览');
    }
    const result = await this.deps.db
      .delete(systemLogs)
      .where(and(where(value.filters), lte(systemLogs.at, new Date(value.preparedAt))));
    return { deleted: result.rowCount };
  }
}
