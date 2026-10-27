import { beforeAll, afterAll, expect, test, vi } from 'vitest';
import { OutputCheckpoint } from '../apps/server/src/modules/pi-runtime/outputCheckpoint.js';
import { artifactToolset } from '../apps/server/src/modules/artifacts/artifactTools.js';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { tasks } from '../packages/db/src/index.js';
import { harness } from './harness.js';
import { withExecution } from '../apps/server/src/modules/mcp/executionContext.js';
let h: Awaited<ReturnType<typeof harness>>;
beforeAll(async () => {
  h = await harness();
});
afterAll(async () => {
  await h?.close();
});
async function setup() {
  const account = await h.signup();
  const source = (await h.services.profiles.save(account.ownerId, { name: 'source' }))!;
  const target = (await h.services.profiles.save(account.ownerId, { name: 'target' }))!;
  const taskId = randomUUID();
  await h.db.insert(tasks).values({
    id: taskId,
    ownerId: account.ownerId,
    profileId: source.id,
    prompt: 'source task',
    status: 'succeeded',
  });
  const artifact = await withExecution(
    {
      ownerId: account.ownerId,
      profileId: source.id,
      identity: `pi:${source.id}`,
      entry: 'pi',
      sessionId: taskId,
      taskId,
      capabilities: {},
    },
    () =>
      h.services.artifacts.store(account.ownerId, {
        name: 'selected.txt',
        body: new Response('artifact content').body,
      }),
  );
  const selection = {
    sourceTaskId: taskId,
    targetProfileId: target.id,
    targetRevision: target.revision,
    summary: 'User selected summary',
    artifactIds: [artifact.id],
    mode: 'pi' as 'pi' | 'external',
  };
  return { account, source, target, taskId, artifact, selection };
}
test('handoff preview and create work without a model, include only selected content and reject changed target revisions', async () => {
  const s = await setup();
  expect(
    (await h.services.handoffs.preview(s.account.ownerId, s.selection)).additionalArtifactIds,
  ).toEqual([s.artifact.id]);
  const row = await h.services.handoffs.create(s.account.ownerId, {
    ...s.selection,
    idempotencyKey: 'new',
  });
  const packet = await h.services.handoffs.export(s.account.ownerId, row.id);
  expect(packet.summary).toBe(s.selection.summary);
  expect(JSON.stringify(packet)).not.toContain('source task');
  expect(packet.artifacts).toHaveLength(1);
  expect(JSON.stringify(packet)).not.toContain('token=');
  await h.services.profiles.save(s.account.ownerId, { name: 'changed' }, s.target.id);
  await expect(h.services.handoffs.execute(s.account.ownerId, row.id)).rejects.toThrow('重新预览');
  expect((await h.services.handoffs.owned(s.account.ownerId, row.id)).status).toBe('failed');
});

test('output checkpoints coalesce text deltas and expose write failures', async () => {
  const write = vi.fn(async (_text: string) => {});
  const failed = vi.fn();
  const checkpoint = new OutputCheckpoint({ write, failed });
  checkpoint.append('one');
  checkpoint.append('one two');
  checkpoint.append('one two three');
  await checkpoint.flush();
  expect(write).toHaveBeenCalledExactlyOnceWith('one two three');
  const failure = new Error('database checkpoint unavailable');
  const broken = new OutputCheckpoint({
    write: async () => {
      throw failure;
    },
    failed,
  });
  broken.append('preserve');
  await expect(broken.flush()).rejects.toThrow('checkpoint unavailable');
  await expect(broken.flush()).rejects.toThrow('checkpoint unavailable');
});

test('Pi handoff artifacts are available through the new task only and are withdrawn when that task ends', async () => {
  const s = await setup();
  const taskId = randomUUID();
  await h.db
    .insert(tasks)
    .values({
      id: taskId,
      ownerId: s.account.ownerId,
      profileId: s.target.id,
      prompt: 'artifact task',
      status: 'running',
    });
  const { temporaryGrants } = await import('../packages/db/src/index.js');
  await h.db
    .insert(temporaryGrants)
    .values({
      id: randomUUID(),
      ownerId: s.account.ownerId,
      profileId: s.target.id,
      profileRevision: s.target.revision,
      subject: `task:${taskId}`,
      taskId,
      bindings: {},
      permissions: { toolIds: [], contentIds: [], artifactIds: [s.artifact.id] },
      expiresAt: new Date(Date.now() + 3600000),
    });
  await withExecution(
    {
      ownerId: s.account.ownerId,
      profileId: s.target.id,
      identity: `pi:${s.target.id}`,
      taskId,
      entry: 'pi',
      sessionId: taskId,
      capabilities: {},
    },
    async () => {
      const toolset = await artifactToolset(h.services, {
        ownerId: s.account.ownerId,
        profileId: s.target.id,
      });
      const result = await toolset.call('platform_artifacts_read', {
        id: s.artifact.id,
        offset: 0,
        length: 8,
      });
      expect(JSON.parse(result.content[0]!.text).data).toBe(
        Buffer.from('artifact').toString('base64'),
      );
      await h.services.pi.store.update(taskId, { status: 'succeeded', endedAt: new Date() });
      await expect(
        toolset.call('platform_artifacts_read', { id: s.artifact.id, offset: 0, length: 8 }),
      ).rejects.toThrow('任务已结束');
    },
  );
});
test('concurrent explicit execution reserves one task and persists model requirement failure without retry', async () => {
  const s = await setup();
  const row = await h.services.handoffs.create(s.account.ownerId, {
    ...s.selection,
    idempotencyKey: 'execute',
  });
  await Promise.all([
    h.services.handoffs.execute(s.account.ownerId, row.id),
    h.services.handoffs.execute(s.account.ownerId, row.id),
  ]);
  const detail = await h.services.handoffs.owned(s.account.ownerId, row.id);
  expect(detail.status).toBe('failed');
  expect(detail.error).toContain('未启用');
  const rows = await h.db.select().from(tasks).where(eq(tasks.handoffId, row.id));
  expect(rows).toHaveLength(1);
  expect(rows[0]!.status).toBe('failed');
  expect((await h.services.handoffs.execute(s.account.ownerId, row.id)).taskId).toBe(detail.taskId);
});
test('external handoff must use target credentials and artifact download stays authenticated and scoped', async () => {
  const s = await setup();
  const wrong = await h.services.profiles.issue(s.account.ownerId, s.source.id);
  await expect(
    h.services.handoffs.preview(s.account.ownerId, {
      ...s.selection,
      mode: 'external',
      credentialId: wrong.id,
    }),
  ).rejects.toThrow('目标');
  const key = await h.services.profiles.issue(s.account.ownerId, s.target.id);
  const row = await h.services.handoffs.create(s.account.ownerId, {
    ...s.selection,
    mode: 'external',
    credentialId: key.id,
    idempotencyKey: 'external',
  });
  const url = `/mcp/${s.target.id}/artifacts/${s.artifact.id}`;
  expect(
    (await h.app.request(url, { headers: { Authorization: `Bearer ${key.token}` } })).status,
  ).toBe(403);
  await h.services.handoffs.execute(s.account.ownerId, row.id);
  expect(
    await (await h.app.request(url, { headers: { Authorization: `Bearer ${key.token}` } })).text(),
  ).toBe('artifact content');
  const other = await h.services.profiles.issue(s.account.ownerId, s.target.id);
  expect(
    (await h.app.request(url, { headers: { Authorization: `Bearer ${other.token}` } })).status,
  ).toBe(403);
  expect((await h.app.request(url)).status).toBe(401);
});
test('handoff creation is idempotent and rejects files outside the selected source task', async () => {
  const s = await setup();
  const input = { ...s.selection, idempotencyKey: 'same' };
  const a = await h.services.handoffs.create(s.account.ownerId, input);
  expect((await h.services.handoffs.create(s.account.ownerId, input)).id).toBe(a.id);
  await expect(
    h.services.handoffs.create(s.account.ownerId, { ...input, summary: 'changed' }),
  ).rejects.toThrow('幂等键');
  await expect(
    h.services.handoffs.preview(s.account.ownerId, { ...s.selection, artifactIds: [randomUUID()] }),
  ).rejects.toThrow('源任务');
  const other = await h.signup();
  await expect(h.services.handoffs.export(other.ownerId, a.id)).rejects.toThrow();
});
test('durable task checkpoints have monotonic revisions and restart marks interrupted work without replay', async () => {
  const s = await setup();
  const id = randomUUID();
  await h.db.insert(tasks).values({
    id,
    ownerId: s.account.ownerId,
    profileId: s.target.id,
    prompt: 'checkpoint',
    status: 'running',
  });
  await h.services.pi.store.update(id, { output: 'first' });
  await h.services.pi.store.update(id, { output: 'first second', status: 'waiting_authorization' });
  const detail = await h.services.pi.store.detail(s.account.ownerId, id);
  expect(detail.output).toBe('first second');
  expect(detail.revision).toBe(3);
  expect(detail.events.map((e) => e.revision)).toEqual([2, 3]);
  await h.services.pi.recover();
  const snapshot = await h.services.pi.store.detail(s.account.ownerId, id);
  expect(snapshot.status).toBe('unknown');
  expect(snapshot.output).toBe('first second');
  expect(snapshot.calls).toHaveLength(0);
});
