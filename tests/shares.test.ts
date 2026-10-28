import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { calls, user } from '../packages/db/src/index.js';
import { harness } from './harness.js';
import { fixtureMcp } from './fixtureMcp.js';
import { fixtureCatalog } from './fixtureCatalog.js';
import { scopedUri } from '../apps/server/src/modules/mcp/catalogEntries.js';
import { contentToolset } from '../apps/server/src/modules/pi-runtime/contentTools.js';

let h: Awaited<ReturnType<typeof harness>>;
let upstream: Awaited<ReturnType<typeof fixtureMcp>>;
let catalog: Awaited<ReturnType<typeof fixtureCatalog>>;
let owner: Awaited<ReturnType<typeof h.signup>>;
let receiver: typeof owner;
let other: typeof owner;
const seenHeaders: (string | null)[] = [];
beforeAll(async () => {
  h = await harness();
  upstream = await fixtureMcp({
    onRequest: (req) => seenHeaders.push(req.headers.get('authorization')),
  });
  catalog = await fixtureCatalog();
  owner = await h.signup();
  receiver = await h.signup();
  other = await h.signup();
});
afterAll(async () => {
  await h?.close();
  await upstream?.close();
  await catalog?.close();
});

async function grant(input: {
  connectionId: string;
  recipient?: typeof receiver;
  toolIds?: string[];
  contentIds?: string[];
  mode?: 'independent' | 'owner';
}) {
  const recipient = input.recipient ?? receiver;
  const [row] = await h.db.select().from(user).where(eq(user.id, recipient.ownerId));
  const response = await owner.request(`/connections/${input.connectionId}/shares`, {
    method: 'PUT',
    body: JSON.stringify({
      recipientEmail: row!.email,
      credentialMode: input.mode,
      toolIds: input.toolIds,
      contentIds: input.contentIds,
    }),
  });
  expect(response.status).toBe(200);
  return response.json() as Promise<{ id: string; version: number; credentialMode: string }>;
}
async function source(adapter = 'direct', url = upstream.url) {
  const connection = await h.services.connections.create(owner.ownerId, {
    name: 'private source',
    adapter,
    transport: 'http',
    mode: 'existing',
    url,
    headers: { Authorization: 'Bearer owner-fixture-only' },
  });
  const tools = await h.services.connections.discover(owner.ownerId, connection.id);
  return { connection, tools };
}

test('independent is the default; pending is explicit and never borrows owner credentials', async () => {
  const { connection, tools } = await source();
  const share = await grant({ connectionId: connection.id, toolIds: [tools[0]!.id] });
  expect(share.credentialMode).toBe('independent');
  const incoming = await (await receiver.request('/shares')).json();
  expect(incoming).toEqual(
    expect.arrayContaining([expect.objectContaining({ id: share.id, status: 'pending' })]),
  );
  expect(JSON.stringify(incoming)).not.toContain('owner-fixture-only');
  const before = upstream.count();
  await expect(
    h.services.connections.discover(receiver.ownerId, connection.id),
  ).rejects.toMatchObject({ code: 'SHARE_CONFIGURATION_PENDING' });
  expect(upstream.count()).toBe(before);
  const configured = await receiver.request(`/shares/${share.id}/configuration`, {
    method: 'PUT',
    body: JSON.stringify({
      name: 'my identity',
      adapter: 'direct',
      transport: 'http',
      mode: 'existing',
      url: upstream.url,
      headers: { Authorization: 'Bearer receiver-fixture-only' },
    }),
  });
  expect(configured.status).toBe(200);
  seenHeaders.length = 0;
  await h.services.invocations.call({
    ownerId: receiver.ownerId,
    toolId: tools[0]!.id,
    arguments: { message: 'receiver' },
  });
  expect(seenHeaders.length).toBeGreaterThan(0);
  expect(new Set(seenHeaders)).toEqual(new Set(['Bearer receiver-fixture-only']));
  const outgoing = JSON.stringify(
    await (await owner.request(`/connections/${connection.id}/shares`)).json(),
  );
  expect(outgoing).not.toContain('receiver-fixture-only');
  expect(outgoing).not.toContain('receiverConfig');
  expect(
    (await receiver.request(`/connections/${connection.id}`, { method: 'PATCH', body: '{}' }))
      .status,
  ).toBe(404);
  expect((await receiver.request(`/connections/${connection.id}/shares`)).status).toBe(404);
});

test('owner credentials retain separate sessions and audit identity; one revocation does not affect owner or another recipient', async () => {
  const { connection, tools } = await source();
  const toolId = tools[0]!.id;
  const share = await grant({ connectionId: connection.id, toolIds: [toolId], mode: 'owner' });
  await grant({ connectionId: connection.id, recipient: other, toolIds: [toolId], mode: 'owner' });
  const contexts = await Promise.all(
    [owner, receiver, other].map((a) => h.services.connections.context(a.ownerId, connection.id)),
  );
  expect(new Set(contexts.map((c) => c.runtimeKey)).size).toBe(3);
  expect(contexts[1]).toMatchObject({
    ownerId: receiver.ownerId,
    resourceOwnerId: owner.ownerId,
    credentialScope: { ownerId: owner.ownerId },
    shareId: share.id,
  });
  const profile = (await h.services.profiles.save(receiver.ownerId, {
    name: 'receiver',
    toolIds: [toolId],
  }))!;
  const empty = (await h.services.profiles.save(receiver.ownerId, { name: 'empty' }))!;
  expect(await h.services.profiles.catalog(receiver.ownerId, empty.id)).toEqual([]);
  seenHeaders.length = 0;
  await h.services.invocations.call({
    ownerId: receiver.ownerId,
    profileId: profile.id,
    toolId,
    arguments: {},
  });
  expect(new Set(seenHeaders)).toEqual(new Set(['Bearer owner-fixture-only']));
  const records = await h.db.select().from(calls).where(eq(calls.shareId, share.id));
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({
    ownerId: receiver.ownerId,
    resourceOwnerId: owner.ownerId,
    credentialOwnerId: owner.ownerId,
  });
  expect((await receiver.request(`/connections/${connection.id}/oauth`)).status).toBe(403);
  expect(
    (await receiver.request(`/connections/${connection.id}/oauth`, { method: 'DELETE' })).status,
  ).toBe(403);
  const before = upstream.count();
  const running = h.services.invocations.call({
    ownerId: receiver.ownerId,
    profileId: profile.id,
    toolId,
    arguments: { delay: 400 },
  });
  const rejected = expect(running).rejects.toMatchObject({ code: 'RESULT_UNKNOWN' });
  await vi.waitFor(async () =>
    expect(
      (await h.db.select().from(calls).where(eq(calls.shareId, share.id))).some(
        (c) => c.status === 'running',
      ),
    ).toBe(true),
  );
  // A running audit row precedes authorization checks; wait for actual dispatch
  // before asserting that revocation leaves the upstream result unknown.
  await vi.waitFor(() => expect(upstream.count()).toBe(before + 1));
  await h.services.shares.revoke(owner.ownerId, share.id);
  await rejected;
  expect(await h.services.profiles.catalog(receiver.ownerId, profile.id)).toEqual([]);
  for (const account of [owner, other])
    await expect(
      h.services.invocations.call({ ownerId: account.ownerId, toolId, arguments: {} }),
    ).resolves.toMatchObject({ structuredContent: { name: 'echo' } });
  expect((await h.services.connections.owned(owner.ownerId, connection.id)).status).toBe(
    'connected',
  );
});

test('content grants and built-in Pi content tools use recipient permissions; subscription revocation is isolated', async () => {
  const { connection, tools } = await source('direct', catalog.url);
  const entries = await h.services.content.catalog({ ownerId: owner.ownerId }, connection.id);
  const resource = entries.find((entry) => entry.name === 'shared')!;
  const prompt = entries.find((entry) => entry.name === 'review')!;
  const share = await grant({
    connectionId: connection.id,
    contentIds: [resource.id],
    toolIds: [tools[0]!.id],
    mode: 'owner',
  });
  const profile = (await h.services.profiles.save(receiver.ownerId, {
    name: 'content',
    contentIds: [resource.id],
  }))!;
  const access = { ownerId: receiver.ownerId, profileId: profile.id };
  const visible = await h.services.content.catalog(access, connection.id);
  expect(visible.map((entry) => entry.id)).toEqual([resource.id]);
  expect(visible[0]?.callerId).toBe(receiver.ownerId);
  await expect(
    h.services.profiles.save(receiver.ownerId, { name: 'forbidden', contentIds: [prompt.id] }),
  ).rejects.toThrow(/未获共享授权/);
  const toolset = await contentToolset(h.services.content, access);
  const uri = scopedUri(connection.id, resource.locator);
  await expect(toolset.call('platform_mcp_resource', { uri })).resolves.toBeDefined();
  let revoked = false;
  const stop = await h.services.content.subscribe(visible[0]!, resource.locator, () => {
    revoked = true;
  });
  await h.services.shares.revoke(owner.ownerId, share.id);
  expect(revoked).toBe(true);
  await expect(toolset.call('platform_mcp_resource', { uri })).rejects.toThrow(/未授权/);
  await stop();
  await expect(h.services.content.read({ ownerId: owner.ownerId, uri })).resolves.toBeDefined();
});

test('grant version changes invalidate recipient snapshots before using updated independent configuration', async () => {
  const { connection, tools } = await source();
  const share = await grant({
    connectionId: connection.id,
    toolIds: [tools[0]!.id],
    mode: 'owner',
  });
  await h.services.connections.discover(receiver.ownerId, connection.id);
  const previous = await h.services.connections.context(receiver.ownerId, connection.id);
  expect(await h.services.connections.bindings.snapshot(previous)).toBeDefined();
  const [recipient] = await h.db.select().from(user).where(eq(user.id, receiver.ownerId));
  await h.services.shares.save(owner.ownerId, connection.id, {
    recipientEmail: recipient!.email,
    version: share.version,
    toolIds: [tools[0]!.id],
    credentialMode: 'independent',
  });
  await expect(
    h.services.connections.context(receiver.ownerId, connection.id),
  ).rejects.toMatchObject({ code: 'SHARE_CONFIGURATION_PENDING' });
  await expect(h.services.shares.assertContext(previous)).rejects.toMatchObject({
    code: 'SHARE_SUPERSEDED',
  });
  await expect(
    h.services.shares.save(owner.ownerId, connection.id, {
      recipientEmail: recipient!.email,
      version: share.version,
    }),
  ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
});

test('real Pi bridges share credentials while keeping separate workers and receiver audit ownership', async () => {
  const { connection, tools } = await source('pi');
  await grant({ connectionId: connection.id, toolIds: [tools[0]!.id], mode: 'owner' });
  seenHeaders.length = 0;
  await expect(
    h.services.invocations.call({
      ownerId: receiver.ownerId,
      toolId: tools[0]!.id,
      arguments: { message: 'Pi shared' },
    }),
  ).resolves.toMatchObject({ structuredContent: { name: 'echo' } });
  expect(new Set(seenHeaders)).toEqual(new Set(['Bearer owner-fixture-only']));
  const ownerContext = await h.services.connections.context(owner.ownerId, connection.id);
  const receiverContext = await h.services.connections.context(receiver.ownerId, connection.id);
  expect(ownerContext.runtimeKey).not.toBe(receiverContext.runtimeKey);
  expect(receiverContext.credentialScope).toEqual(ownerContext.credentialScope);
  await expect(h.services.pi.action(receiverContext, { action: 'status' })).rejects.toMatchObject({
    status: 403,
  });
}, 30_000);
