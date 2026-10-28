import { expect, test, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { calls } from '../packages/db/src/index.js';
import { RuntimeMetrics } from '../apps/server/src/modules/activity/runtimeMetrics.js';
import { harness } from './harness.js';
import { fixtureMcp } from './fixtureMcp.js';
let h: Awaited<ReturnType<typeof harness>>, upstream: Awaited<ReturnType<typeof fixtureMcp>>;
beforeAll(async () => {
  h = await harness();
  upstream = await fixtureMcp();
});
afterAll(async () => {
  await h?.close();
  await upstream?.close();
});
test('logical duration includes waiting, execution excludes it; terminal accounting is idempotent and reset is process-local', () => {
  let clock = 0;
  const metrics = new RuntimeMetrics(() => clock);
  metrics.begin('private-call-id', { labels: { entry: 'rest', adapter: 'direct' } });
  metrics.resume('private-call-id');
  clock = 100;
  metrics.pause('private-call-id');
  expect(metrics.render().join('\n')).not.toContain('platform_calls_total{');
  clock = 1100;
  metrics.resume('private-call-id');
  clock = 1200;
  metrics.finish('private-call-id', 'succeeded');
  metrics.finish('private-call-id', 'failed');
  const output = metrics.render().join('\n');
  expect(output).toContain(
    'platform_calls_total{entry="rest",adapter="direct",status="succeeded"} 1',
  );
  expect(output).toContain(
    'platform_call_total_duration_seconds_sum{entry="rest",adapter="direct",status="succeeded"} 1.2',
  );
  expect(output).toContain(
    'platform_call_execution_duration_seconds_sum{entry="rest",adapter="direct",status="succeeded"} 0.2',
  );
  expect(output).not.toContain('private-call-id');
  expect(new RuntimeMetrics().render().join('\n')).not.toContain('platform_calls_total{');
});
test('terminal status labels are finite, cancellation remains separate from unknown and search from business calls', () => {
  const metrics = new RuntimeMetrics();
  for (const status of ['succeeded', 'tool_error', 'failed', 'unknown', 'cancelled'] as const) {
    metrics.begin(status, { labels: { entry: 'gateway', adapter: 'device' } });
    if (status === 'cancelled') metrics.cancel(status);
    metrics.finish(status, status === 'cancelled' ? 'unknown' : status);
  }
  metrics.search({ strategy: 'exact', status: 'succeeded', durationMs: 20 });
  const output = metrics.render().join('\n');
  expect(output.match(/^platform_calls_total\{/gm)).toHaveLength(5);
  expect(output).toContain('platform_searches_total{strategy="exact",status="succeeded"} 1');
  expect(output).toContain('le="+Inf"} 1');
});
test('real REST idempotency and deleting retained history do not duplicate or reset cumulative calls', async () => {
  const { ownerId } = await h.signup();
  const connection = await h.services.connections.create(ownerId, {
    name: 'metrics',
    adapter: 'direct',
    mode: 'existing',
    transport: 'http',
    url: upstream.url,
  });
  const [tool] = await h.services.connections.discover(ownerId, connection.id);
  const profile = (await h.services.profiles.save(ownerId, {
    name: 'metrics',
    toolIds: [tool!.id],
  }))!;
  const key = await h.services.profiles.issue(ownerId, profile.id);
  const invoke = () =>
    fetch(`${h.baseURL}/mcp/${profile.id}/rest/tools/${tool!.id}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key.token}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': 'metrics',
      },
      body: JSON.stringify({ message: 'once' }),
    });
  expect((await invoke()).status).toBe(200);
  expect((await invoke()).status).toBe(200);
  const before = h.services.metrics.render().join('\n');
  expect(before).toContain(
    'platform_calls_total{entry="rest",adapter="direct",status="succeeded"} 1',
  );
  await h.db.delete(calls).where(eq(calls.ownerId, ownerId));
  expect(h.services.metrics.render().join('\n')).toBe(before);
});
