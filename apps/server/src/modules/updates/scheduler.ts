import { and, eq, lte } from 'drizzle-orm';
import { updateChecks, type Database } from '@platform/db';
import { UPDATE_INTERVAL_MS } from './packageService.js';
export type UpdateClock = { now: () => Date; every: (fn: () => void, ms: number) => () => void };
export async function startUpdateChecks(deps: {
  db: Database;
  clock: UpdateClock;
  packageCheck: (owner: string, id: string) => Promise<unknown>;
  platformCheck: () => Promise<unknown>;
  failed: () => void;
}) {
  // Restart starts a new interval: missed checks are never replayed.
  await deps.db
    .update(updateChecks)
    .set({ nextCheckAt: new Date(deps.clock.now().getTime() + UPDATE_INTERVAL_MS) })
    .where(eq(updateChecks.scheduled, true));
  let pending: Promise<void> | undefined;
  const tick = async () => {
    const now = deps.clock.now();
    const due = await deps.db
      .select()
      .from(updateChecks)
      .where(and(eq(updateChecks.scheduled, true), lte(updateChecks.nextCheckAt, now)));
    for (const row of due) {
      const claimed = await deps.db
        .update(updateChecks)
        .set({ nextCheckAt: new Date(now.getTime() + UPDATE_INTERVAL_MS) })
        .where(
          and(
            eq(updateChecks.id, row.id),
            eq(updateChecks.scheduled, true),
            lte(updateChecks.nextCheckAt, now),
          ),
        )
        .returning();
      if (!claimed.length) continue;
      try {
        if (row.ownerId && row.connectionId) await deps.packageCheck(row.ownerId, row.connectionId);
        else if (row.id === 'platform') await deps.platformCheck();
      } catch {
        deps.failed();
      }
    }
  };
  const stop = deps.clock.every(() => {
    pending ??= tick()
      .catch(deps.failed)
      .finally(() => {
        pending = undefined;
      });
  }, 60_000);
  return async () => {
    stop();
    await pending;
  };
}
