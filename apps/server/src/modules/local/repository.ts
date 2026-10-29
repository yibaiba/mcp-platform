import { and, eq, desc, sql } from 'drizzle-orm';
import {
  localBindings,
  localOperations,
  localSources,
  profiles,
  tools,
  mcpEntries,
  type Database,
} from '@platform/db';
import { randomUUID } from 'node:crypto';
import type { LocalResource, LocalState } from '@platform/contracts';
import { digest } from '../../shared/crypto.js';
import { AppError, requireValue } from '../../shared/errors.js';
export type Binding = typeof localBindings.$inferSelect;
export class LocalRepository {
  constructor(readonly db: Database) {}
  withDeviceLock<T>(id: string, work: () => Promise<T>) {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${id}, 0))`);
      return work();
    });
  }
  async existingOperation(ownerId: string, deviceId: string, key: string) {
    const [row] = await this.db
      .select()
      .from(localOperations)
      .where(eq(localOperations.id, digest(`${ownerId}:${deviceId}:${key}`)));
    return row;
  }
  async authorizationSummary(ownerId: string, rows: Binding[]) {
    const [agents, toolRows, contentRows] = await Promise.all([
      this.db.select().from(profiles).where(eq(profiles.ownerId, ownerId)),
      this.db.select().from(tools).where(eq(tools.ownerId, ownerId)),
      this.db.select().from(mcpEntries).where(eq(mcpEntries.ownerId, ownerId)),
    ]);
    return new Map(
      rows.map((row) => [
        row.id,
        agents
          .filter((agent) =>
            row.skillVersionId
              ? agent.skillVersionIds.includes(row.skillVersionId)
              : [...toolRows, ...contentRows].some(
                  (item) =>
                    item.connectionId === row.connectionId &&
                    (agent.toolIds.includes(item.id) || agent.contentIds.includes(item.id)),
                ),
          )
          .map((agent) => agent.name),
      ]),
    );
  }
  list(ownerId: string, deviceId: string) {
    return this.db
      .select()
      .from(localBindings)
      .where(and(eq(localBindings.ownerId, ownerId), eq(localBindings.deviceId, deviceId)));
  }
  async owned(ownerId: string, input: { deviceId: string; id: string }) {
    const [row] = await this.db
      .select()
      .from(localBindings)
      .where(
        and(
          eq(localBindings.ownerId, ownerId),
          eq(localBindings.deviceId, input.deviceId),
          eq(localBindings.id, input.id),
        ),
      );
    return requireValue(row);
  }
  async snapshot(ownerId: string, deviceId: string, state: LocalState) {
    for (const source of state.sources)
      await this.db
        .insert(localSources)
        .values({
          id: digest(`${deviceId}:${source.id}`),
          ownerId,
          deviceId,
          sourceId: source.id,
          metadata: source,
        })
        .onConflictDoUpdate({ target: localSources.id, set: { metadata: source } });
    for (const resource of Object.values(state.resources)) {
      if (!resource.selected || resource.readOnly) continue;
      const { content, ...metadata } = resource;
      await this.db
        .insert(localBindings)
        .values({
          id: randomUUID(),
          ownerId,
          deviceId,
          resourceId: resource.id,
          metadata,
          baseline: content,
          content,
          localDigest: resource.digest,
        })
        .onConflictDoNothing();
    }
  }
  async patch(row: Binding, patch: Partial<Binding>, db: Pick<Database, 'update'> = this.db) {
    const [updated] = await db
      .update(localBindings)
      .set({ ...patch, revision: row.revision + 1, updatedAt: new Date() })
      .where(and(eq(localBindings.id, row.id), eq(localBindings.revision, row.revision)))
      .returning();
    if (!updated) throw new AppError('REVISION_CONFLICT', '同步副本已改变，请重新加载', 409);
    return updated;
  }
  commit(row: Binding, input: { patch: Partial<Binding>; operationId: string }) {
    return this.db.transaction(async (tx) => {
      const updated = await this.patch(row, input.patch, tx);
      await tx
        .update(localOperations)
        .set({ phase: 'succeeded', result: updated })
        .where(eq(localOperations.id, input.operationId));
      return updated;
    });
  }
  operations(ownerId: string, deviceId: string) {
    return this.db
      .select()
      .from(localOperations)
      .where(and(eq(localOperations.ownerId, ownerId), eq(localOperations.deviceId, deviceId)))
      .orderBy(desc(localOperations.createdAt));
  }
  async operation(
    ownerId: string,
    input: { deviceId: string; key: string; action: string; payload: Record<string, unknown> },
  ) {
    const id = digest(`${ownerId}:${input.deviceId}:${input.key}`);
    const requestDigest = digest(JSON.stringify(input.payload));
    await this.db
      .insert(localOperations)
      .values({
        id,
        ownerId,
        deviceId: input.deviceId,
        requestDigest,
        action: input.action,
        phase: 'pending',
        input: input.payload,
      })
      .onConflictDoNothing();
    const [row] = await this.db.select().from(localOperations).where(eq(localOperations.id, id));
    const value = requireValue(row);
    if (value.requestDigest !== requestDigest)
      throw new AppError('IDEMPOTENCY_CONFLICT', '操作键已用于不同请求', 409);
    return value;
  }
  finish(id: string, patch: { phase: string; result?: unknown; error?: string }) {
    return this.db.update(localOperations).set(patch).where(eq(localOperations.id, id));
  }
}
export function metadata(resource: LocalResource) {
  const { content: _content, ...value } = resource;
  return value;
}
export function equal(a: unknown, b: unknown): boolean {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, item]) => [key, canonical(item)]),
      );
    return value;
  };
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}
