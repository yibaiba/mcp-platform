import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { calls, systemLogs, user } from '../packages/db/src/index.js';
import { SystemLogger } from '../apps/server/src/modules/activity/systemLogger.js';
import { harness } from './harness.js';
import { envSchema } from '../apps/server/src/config.js';
let h: Awaited<ReturnType<typeof harness>>;
let account: Awaited<ReturnType<typeof h.signup>>;
beforeAll(async () => {
  h = await harness();
  h.app.all('*', (c) => c.notFound());
  account = await h.signup();
});
afterAll(async () => {
  await h.db.delete(systemLogs).where(eq(systemLogs.ownerId, account.ownerId));
  await h.close();
});

test('cursor paging preserves PostgreSQL timestamp precision, filters and private ownership', async () => {
  const other = await h.signup();
  const connectionId = randomUUID();
  const toolId = randomUUID();
  const startedAt = sql`'2025-01-02 03:04:05.123456+00'::timestamptz`;
  const ids = Array.from({ length: 3 }, () => randomUUID())
    .sort()
    .reverse();
  await h.db.insert(calls).values(
    ids.map((id) => ({
      id,
      ownerId: account.ownerId,
      toolId,
      connectionId,
      adapter: 'direct',
      status: 'succeeded',
      startedAt,
      endedAt: new Date('2025-01-02T03:04:07Z'),
    })),
  );
  await h.db.insert(calls).values({
    id: randomUUID(),
    ownerId: other.ownerId,
    toolId,
    connectionId,
    adapter: 'direct',
    status: 'succeeded',
    startedAt,
  });
  const filters = {
    toolId,
    status: 'succeeded',
    from: '2025-01-01T00:00:00Z',
    before: '2025-01-03T00:00:00Z',
  };
  let cursor: string | null = null;
  const found: string[] = [];
  for (let i = 0; i < 3; i++) {
    const page = await h.services.activity.list(account.ownerId, {
      ...filters,
      limit: '1',
      ...(cursor ? { cursor } : {}),
    });
    found.push(...page.items.map((row) => row.id));
    cursor = page.nextCursor;
  }
  expect(found).toEqual(ids);
  expect(cursor).toBeNull();
  expect(await h.services.activity.stats(account.ownerId, filters)).toMatchObject([
    { status: 'succeeded', count: 3 },
  ]);
  await expect(h.services.activity.detail(other.ownerId, ids[0]!)).rejects.toMatchObject({
    status: 404,
  });
  expect((await account.request('/activity/calls?cursor=malformed')).status).toBe(400);
  expect((await account.request('/calls')).status).toBe(200);
});

test('cleanup preview binds owner and completed snapshot, excluding running and waiting calls', async () => {
  const other = await h.signup();
  const connectionId = randomUUID();
  const values = ['running', 'waiting', 'succeeded'].map((status) => ({
    id: randomUUID(),
    ownerId: account.ownerId,
    toolId: 'cleanup',
    connectionId,
    status,
    adapter: 'pi',
    endedAt: status === 'succeeded' ? new Date(Date.now() - 1000) : null,
  }));
  await h.db.insert(calls).values(values);
  const preview = await h.services.activity.preview(account.ownerId, { connectionId });
  expect(preview.count).toBe(1);
  await expect(
    h.services.activity.clear(other.ownerId, { token: preview.token }),
  ).rejects.toMatchObject({ code: 'CLEANUP_PREVIEW' });
  const later = randomUUID();
  await h.db.insert(calls).values({
    id: later,
    ownerId: account.ownerId,
    toolId: 'cleanup',
    connectionId,
    status: 'succeeded',
    adapter: 'pi',
    endedAt: new Date(Date.now() + 1000),
  });
  expect(await h.services.activity.clear(account.ownerId, { token: preview.token })).toEqual({
    deleted: 1,
  });
  expect(
    (await h.services.activity.list(account.ownerId, { connectionId })).items
      .map((row) => row.id)
      .sort(),
  ).toEqual([values[0]!.id, values[1]!.id, later].sort());
});

test('system logs require admin and persist only request metadata', async () => {
  expect((await account.request('/admin/logs')).status).toBe(403);
  await h.db.update(user).set({ role: 'admin' }).where(eq(user.id, account.ownerId));
  const privatePayload = `secret-${randomUUID()}`;
  await account.request('/import/preview', {
    method: 'POST',
    body: JSON.stringify({ unexpected: privatePayload }),
  });
  const records = await h.db
    .select()
    .from(systemLogs)
    .where(eq(systemLogs.ownerId, account.ownerId));
  expect(
    records.some((row) => row.event === 'http_request' && row.route === '/api/v1/import/preview'),
  ).toBe(true);
  expect(JSON.stringify(records)).not.toContain(privatePayload);
  expect((await account.request('/admin/logs?limit=2')).status).toBe(200);
});

test('log persistence failure is explicit, emits no raw cause or payload and rejects unexpected fields', async () => {
  const stdout: string[] = [],
    stderr: string[] = [];
  const logger = new SystemLogger({
    persist: async () => {
      throw new Error('credential-secret-in-driver-error');
    },
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
  });
  await expect(logger.write({ level: 'error', event: 'http_request' })).rejects.toMatchObject({
    code: 'LOG_PERSISTENCE_FAILED',
    status: 503,
  });
  expect(stdout).toHaveLength(0);
  expect(stderr.join()).toContain('log_persistence_failed');
  expect(stderr.join()).not.toContain('credential-secret');
  await expect(
    logger.write({ level: 'info', event: 'http_request', payload: 'private' } as never),
  ).rejects.toThrow();
  logger.report('BACKGROUND_WRITE_FAILED');
  await expect(logger.drain()).rejects.toThrow('系统日志持久化失败');
  expect(stderr.join()).not.toContain('credential-secret');
});

test('background runtime diagnostics persist metadata and are drained before database shutdown', async () => {
  h.services.logger.report('CONNECTION_RECOVERY_FAILED', account.ownerId);
  await h.services.logger.drain();
  const rows = await h.db.select().from(systemLogs).where(eq(systemLogs.ownerId, account.ownerId));
  expect(rows).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ event: 'runtime_failure', code: 'CONNECTION_RECOVERY_FAILED' }),
    ]),
  );
});

test('metrics is explicitly enabled and needs a separate credential, with metadata-only labels', async () => {
  expect((await h.app.request('/metrics')).status).toBe(404);
  h.config.METRICS_ENABLED = 'true';
  h.config.METRICS_TOKEN = randomUUID();
  expect((await h.app.request('/metrics', { headers: { Cookie: account.cookie } })).status).toBe(
    401,
  );
  const response = await h.app.request('/metrics', {
    headers: { Authorization: `Bearer ${h.config.METRICS_TOKEN}` },
  });
  expect(response.status).toBe(200);
  const text = await response.text();
  expect(text).toContain('platform_retained_calls{adapter="direct",status="succeeded"}');
  expect(text).not.toContain(account.ownerId);
  expect(text).not.toContain(h.config.METRICS_TOKEN);
});

test('optional Compose settings accept empty values but enabled metrics and invalid provider settings fail explicitly', () => {
  const input = {
    ...h.config,
    METRICS_ENABLED: 'false',
    METRICS_TOKEN: '',
    AUTH_PROVIDERS: '',
    CALL_RETENTION_DAYS: '',
    LOG_RETENTION_DAYS: '',
  };
  expect(envSchema.parse(input)).toMatchObject({
    METRICS_ENABLED: 'false',
    METRICS_TOKEN: undefined,
    AUTH_PROVIDERS: undefined,
    CALL_RETENTION_DAYS: undefined,
  });
  expect(envSchema.safeParse({ ...input, METRICS_ENABLED: 'true' }).success).toBe(false);
  expect(envSchema.safeParse({ ...input, AUTH_PROVIDERS: '{broken' }).success).toBe(false);
  expect(envSchema.safeParse({ ...input, CALL_RETENTION_DAYS: '0' }).success).toBe(false);
});

test('live logs stop with an explicit error when admin permission is removed', async () => {
  await h.db.update(user).set({ role: 'admin' }).where(eq(user.id, account.ownerId));
  const abort = new AbortController();
  const response = await account.request('/admin/logs/stream', { signal: abort.signal });
  const reader = response.body!.getReader();
  let text = '';
  try {
    text += new TextDecoder().decode((await reader.read()).value);
    expect(text).toContain('event: ready');
    await h.db.update(user).set({ role: 'member' }).where(eq(user.id, account.ownerId));
    await h.services.logger.write({
      level: 'info',
      event: 'http_request',
      ownerId: account.ownerId,
    });
    while (!text.includes('ADMIN_REQUIRED')) {
      const part = await reader.read();
      if (part.done) break;
      text += new TextDecoder().decode(part.value);
    }
    expect(text).toContain('ADMIN_REQUIRED');
  } finally {
    abort.abort();
    await reader.cancel();
  }
});
