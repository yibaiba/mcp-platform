import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  tasks,
  calls,
  handoffs,
  artifacts,
  interactions,
  permissionRequests,
  workspaceEvents,
  type Database,
} from '@platform/db';
import type { RuntimeEvents } from '../../shared/runtimeEvents.js';
import { requireValue } from '../../shared/errors.js';
export class TaskStore {
  constructor(private readonly deps: { db: Database; events: RuntimeEvents }) {}
  async update(
    id: string,
    patch: Partial<Pick<typeof tasks.$inferInsert, 'status' | 'output' | 'error' | 'endedAt'>>,
  ) {
    const row = await this.deps.db.transaction(async (tx) => {
      const [row] = await tx
        .update(tasks)
        .set({ ...patch, revision: sql`${tasks.revision} + 1` })
        .where(eq(tasks.id, id))
        .returning();
      const task = requireValue(row);
      await tx.insert(workspaceEvents).values({
        id: randomUUID(),
        ownerId: task.ownerId,
        aggregateId: id,
        kind: 'task',
        revision: task.revision,
        data: { status: task.status, output: task.output, error: task.error },
      });
      if (task.handoffId && ['succeeded', 'failed', 'cancelled', 'unknown'].includes(task.status))
        await tx
          .update(handoffs)
          .set({ status: task.status, error: task.error })
          .where(eq(handoffs.id, task.handoffId));
      return task;
    });
    this.deps.events.publish({
      ownerId: row.ownerId,
      kind: 'task',
      id,
      status: row.status,
      revision: row.revision,
    });
    return row;
  }
  async detail(ownerId: string, id: string) {
    const [row] = await this.deps.db
      .select()
      .from(tasks)
      .where(and(eq(tasks.ownerId, ownerId), eq(tasks.id, id)));
    const task = requireValue(row);
    const callRows = await this.deps.db
      .select()
      .from(calls)
      .where(and(eq(calls.ownerId, ownerId), eq(calls.taskId, id)));
    const [files, requests, events, elicitation] = await Promise.all([
      this.deps.db
        .select()
        .from(artifacts)
        .where(and(eq(artifacts.ownerId, ownerId), eq(artifacts.taskId, id))),
      this.deps.db
        .select()
        .from(permissionRequests)
        .where(and(eq(permissionRequests.ownerId, ownerId), eq(permissionRequests.taskId, id))),
      this.deps.db
        .select()
        .from(workspaceEvents)
        .where(and(eq(workspaceEvents.ownerId, ownerId), eq(workspaceEvents.aggregateId, id)))
        .orderBy(workspaceEvents.revision),
      callRows.length
        ? this.deps.db
            .select({
              id: interactions.id,
              callId: interactions.callId,
              connectionId: interactions.connectionId,
              bindingId: interactions.bindingId,
              status: interactions.status,
            })
            .from(interactions)
            .where(
              and(
                eq(interactions.ownerId, ownerId),
                inArray(
                  interactions.callId,
                  callRows.map((c) => c.id),
                ),
              ),
            )
        : [],
    ]);
    return {
      ...task,
      calls: callRows,
      artifacts: files,
      requests,
      events,
      interactions: elicitation,
      appsStatus: '进程内视图；刷新或重启不重放工具',
    };
  }
}
