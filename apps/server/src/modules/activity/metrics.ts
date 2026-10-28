import { timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { count, sql } from 'drizzle-orm';
import { calls, connections, devices, type Database } from '@platform/db';
import type { Config } from '../../config.js';
import { digest } from '../../shared/crypto.js';
import { durationMs } from './query.js';

export function metricsRoutes(deps: {
  db: Database;
  config: Config;
  online: (id: string) => boolean;
}) {
  const app = new Hono();
  app.get('/metrics', async (c) => {
    if (deps.config.METRICS_ENABLED !== 'true') return c.notFound();
    const received = c.req.header('authorization') ?? '';
    if (
      !timingSafeEqual(
        Buffer.from(digest(received)),
        Buffer.from(digest(`Bearer ${deps.config.METRICS_TOKEN}`)),
      )
    )
      return c.json({ error: 'Invalid metrics credential' }, 401);
    const [counts, states, deviceRows] = await Promise.all([
      deps.db
        .select({
          adapter: calls.adapter,
          status: calls.status,
          count: count(),
          duration: sql<number | null>`avg(${durationMs})::float8 / 1000`,
        })
        .from(calls)
        .groupBy(calls.adapter, calls.status),
      deps.db
        .select({ adapter: connections.adapter, status: connections.status, count: count() })
        .from(connections)
        .groupBy(connections.adapter, connections.status),
      deps.db.select({ id: devices.id, revoked: devices.revoked }).from(devices),
    ]);
    const labels = (row: { adapter: string; status: string }) =>
      `{adapter=${JSON.stringify(row.adapter)},status=${JSON.stringify(row.status)}}`;
    const lines = [
      '# HELP platform_retained_calls Calls currently retained in history, including active calls.',
      '# TYPE platform_retained_calls gauge',
    ];
    for (const row of counts) lines.push(`platform_retained_calls${labels(row)} ${row.count}`);
    lines.push(
      '# HELP platform_call_duration_seconds Mean elapsed duration of retained completed calls.',
      '# TYPE platform_call_duration_seconds gauge',
    );
    for (const row of counts)
      if (row.duration !== null)
        lines.push(`platform_call_duration_seconds${labels(row)} ${row.duration}`);
    lines.push(
      '# HELP platform_connections Current connection state counts.',
      '# TYPE platform_connections gauge',
    );
    for (const row of states) lines.push(`platform_connections${labels(row)} ${row.count}`);
    const statesByDevice = { online: 0, offline: 0, revoked: 0 };
    for (const row of deviceRows)
      statesByDevice[row.revoked ? 'revoked' : deps.online(row.id) ? 'online' : 'offline']++;
    lines.push(
      '# HELP platform_devices Current device state counts.',
      '# TYPE platform_devices gauge',
    );
    for (const [status, count] of Object.entries(statesByDevice))
      lines.push(`platform_devices{status="${status}"} ${count}`);
    c.header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    return c.body(`${lines.join('\n')}\n`);
  });
  return app;
}
