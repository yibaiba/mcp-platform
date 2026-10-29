import { beforeAll, afterAll, expect, test, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { artifacts, resultOriginals } from '../packages/db/src/index.js';
import { excerpt, textBytes } from '../apps/server/src/modules/result-presentation/excerpt.js';
import {
  resultPresentation,
  profileInput,
  manifestProfile,
} from '../packages/contracts/src/index.js';
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
test('UTF-8 proportional excerpts preserve order, head/tail, structured data and media without mutating input', () => {
  const original = {
    content: [
      { type: 'text' as const, text: '开始😀中文'.repeat(80) + '结束' },
      { type: 'image' as const, data: 'binary', mimeType: 'image/png' },
      { type: 'text' as const, text: 'ABC'.repeat(200) + 'END' },
    ],
    structuredContent: { full: 'unchanged' },
  };
  const copy = structuredClone(original);
  const value = excerpt(original, { retainBytes: 200, marker: 'original-id' });
  expect(value.retainedBytes).toBeLessThanOrEqual(200);
  expect(value.result.content.map((block) => block.type)).toEqual(['text', 'image', 'text']);
  expect(value.result.content[1]).toBe(original.content[1]);
  expect(value.result.structuredContent).toBe(original.structuredContent);
  expect(JSON.stringify(value)).not.toContain('\ufffd');
  expect(JSON.stringify(value.result)).toContain('结束');
  expect(JSON.stringify(value.result)).toContain('END');
  expect(original).toEqual(copy);
  expect(excerpt(original, { retainBytes: textBytes(original), marker: 'none' }).result).toBe(
    original,
  );
  expect(profileInput.parse({ name: 'new' }).resultPresentation.enabled).toBe(false);
  expect(manifestProfile.parse({ name: 'old' }).resultPresentation.enabled).toBe(false);
  expect(() => resultPresentation.parse({ thresholdBytes: 10, retainBytes: 20 })).toThrow();
});
async function setup() {
  const account = await h.signup();
  const connection = await h.services.connections.create(account.ownerId, {
    name: 'excerpt',
    adapter: 'direct',
    mode: 'existing',
    transport: 'http',
    url: upstream.url,
  });
  const [tool] = await h.services.connections.discover(account.ownerId, connection.id);
  const profile = (await h.services.profiles.save(account.ownerId, {
    name: 'excerpt',
    toolIds: [tool!.id],
    resultPresentation: { enabled: true, thresholdBytes: 100, retainBytes: 30 },
  }))!;
  const key = await h.services.profiles.issue(account.ownerId, profile.id);
  const base = `${h.baseURL}/mcp/${profile.id}`;
  const invoke = (token = key.token, idempotencyKey = 'once') =>
    fetch(`${base}/rest/tools/${tool!.id}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify({ message: '开头😀'.repeat(80) + '完整结尾' }),
    });
  return { ...account, connection, tool: tool!, profile, key, base, invoke };
}
test('real REST stores one complete original, reuses the persisted display, rejects other credentials and current tool revocation', async () => {
  const s = await setup(),
    before = upstream.count();
  const response = await s.invoke();
  expect(response.status).toBe(200);
  const displayed = await response.json();
  const metadata = displayed._meta['platform/resultExcerpt'];
  expect(metadata.retainedTextBytes).toBeLessThanOrEqual(30);
  expect(displayed.structuredContent).toEqual({ name: 'echo' });
  expect((await s.invoke()).status).toBe(200);
  expect(upstream.count()).toBe(before + 1);
  expect(await (await s.invoke()).json()).toEqual(displayed);
  expect(
    await h.db
      .select()
      .from(resultOriginals)
      .where(eq(resultOriginals.artifactId, metadata.artifactId)),
  ).toHaveLength(1);
  const download = (token: string) =>
    fetch(`${h.baseURL}${metadata.downloadPath}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  const full = await download(s.key.token);
  expect(full.status).toBe(200);
  expect(full.headers.get('X-Content-SHA256')).toBe(metadata.sha256);
  const original = await full.json();
  expect(original.content[0].text).toBe('开头😀'.repeat(80) + '完整结尾');
  expect(original).not.toHaveProperty('_meta.platform/resultExcerpt');
  const other = await h.services.profiles.issue(s.ownerId, s.profile.id);
  expect((await download(other.token)).status).toBe(403);
  await h.services.profiles.save(s.ownerId, { name: s.profile.name, toolIds: [] }, s.profile.id);
  expect((await download(s.key.token)).status).toBe(403);
});
test('persistence failure exposes upstream completion uncertainty and a stable call ID without success or replay', async () => {
  const s = await setup(),
    before = upstream.count();
  const store = vi
    .spyOn(h.services.artifacts, 'store')
    .mockRejectedValueOnce(Object.assign(new Error('disk full'), { code: 'ENOSPC' }));
  const response = await s.invoke();
  store.mockRestore();
  expect(response.status).toBe(500);
  const error = await response.json();
  expect(error.code).toBe('RESULT_ORIGINAL_SAVE_FAILED');
  expect(error.error).toContain('调用 ID');
  expect(error.error).toContain('上游可能已完成');
  const retry = await s.invoke();
  expect(retry.status).toBe(500);
  expect((await retry.json()).status).toBe('result_error');
  expect(upstream.count()).toBe(before + 1);
  expect(await h.db.select().from(artifacts).where(eq(artifacts.ownerId, s.ownerId))).toEqual([]);
});
