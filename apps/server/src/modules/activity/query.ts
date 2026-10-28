import { z } from 'zod';
import { and, eq, gte, lt, sql } from 'drizzle-orm';
import { calls } from '@platform/db';
export const filtersSchema = z
  .object({
    from: z.iso.datetime({ offset: true }).optional(),
    before: z.iso.datetime({ offset: true }).optional(),
    toolId: z.string().min(1).optional(),
    connectionId: z.uuid().optional(),
    deviceId: z.uuid().optional(),
    profileId: z.uuid().optional(),
    taskId: z.uuid().optional(),
    status: z
      .enum(['running', 'waiting', 'succeeded', 'tool_error', 'failed', 'unknown', 'cancelled'])
      .optional(),
  })
  .strict()
  .refine(
    (v) => !v.from || !v.before || Date.parse(v.from) < Date.parse(v.before),
    '时间范围必须递增',
  );
export type CallFilters = z.infer<typeof filtersSchema>;
export const pageSchema = z.object({
  limit: z.coerce.number().int().positive().default(50),
  cursor: z.string().optional(),
});
const cursorSchema = z
  .object({
    at: z
      .string()
      .regex(/^\d{4}-\d\d-\d\d[ T]\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d(?::?\d\d)?)$/)
      .refine((value) => Number.isFinite(Date.parse(value))),
    id: z.uuid(),
  })
  .strict();
export function decodeCursor(value?: string) {
  if (!value) return undefined;
  try {
    return cursorSchema.parse(JSON.parse(Buffer.from(value, 'base64url').toString()));
  } catch {
    throw new Error('INVALID_CURSOR');
  }
}
export const encodeCursor = (value: { cursorAt: string; id: string }) =>
  Buffer.from(JSON.stringify({ at: value.cursorAt, id: value.id })).toString('base64url');
export function callWhere(ownerId: string, value: CallFilters) {
  return and(
    eq(calls.ownerId, ownerId),
    value.from ? gte(calls.startedAt, new Date(value.from)) : undefined,
    value.before ? lt(calls.startedAt, new Date(value.before)) : undefined,
    ...(['toolId', 'connectionId', 'deviceId', 'profileId', 'taskId', 'status'] as const).map(
      (key) => (value[key] ? eq(calls[key], value[key]) : undefined),
    ),
  );
}
export const durationMs = sql<number>`extract(epoch from (${calls.endedAt} - ${calls.startedAt})) * 1000`;
