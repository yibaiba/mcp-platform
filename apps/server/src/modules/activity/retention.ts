import { and, isNotNull, lt, notInArray } from 'drizzle-orm';
import { calls, systemLogs, type Database } from '@platform/db';
import type { SystemLogger } from './systemLogger.js';
const DAY_MS = 24 * 60 * 60 * 1000;
const CHECK_INTERVAL_MS = 60 * 60 * 1000;

export function startRetention(deps: {
  db: Database;
  logger: SystemLogger;
  callDays?: number;
  logDays?: number;
}) {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let pending = Promise.resolve();
  const run = async () => {
    const now = Date.now();
    if (deps.callDays !== undefined)
      await deps.db
        .delete(calls)
        .where(
          and(
            notInArray(calls.status, ['running', 'waiting']),
            isNotNull(calls.endedAt),
            lt(calls.endedAt, new Date(now - deps.callDays * DAY_MS)),
          ),
        );
    if (deps.logDays !== undefined)
      await deps.db
        .delete(systemLogs)
        .where(lt(systemLogs.at, new Date(now - deps.logDays * DAY_MS)));
    await deps.logger.write({ level: 'info', event: 'retention_cleanup' });
  };
  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(() => {
      pending = run()
        .catch((error: unknown) => {
          console.error(
            JSON.stringify({
              level: 'error',
              event: 'retention_failed',
              code: error instanceof Error ? error.name : 'UnknownError',
            }),
          );
        })
        .finally(schedule);
    }, CHECK_INTERVAL_MS);
    timer.unref();
  };
  if (deps.callDays !== undefined || deps.logDays !== undefined) schedule();
  return async () => {
    stopped = true;
    clearTimeout(timer);
    await pending;
  };
}
