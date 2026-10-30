import { beforeAll, afterAll, expect, test, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { tasks, temporaryGrants } from '../packages/db/src/index.js';
import { harness } from './harness.js';
import { fixtureMcp } from './fixtureMcp.js';
import { fixtureCatalog } from './fixtureCatalog.js';
import { withExecution } from '../apps/server/src/modules/mcp/executionContext.js';
import { scopedUri } from '../apps/server/src/modules/mcp/catalogEntries.js';
let h: Awaited<ReturnType<typeof harness>>;
let upstream: Awaited<ReturnType<typeof fixtureMcp>>;
let catalog: Awaited<ReturnType<typeof fixtureCatalog>>;
beforeAll(async () => {
  h = await harness();
  upstream = await fixtureMcp();
  catalog = await fixtureCatalog();
});
afterAll(async () => {
  await h?.close();
  await upstream?.close();
  await catalog?.close();
});
const none = () => ({
  toolIds: [] as string[],
  contentIds: [] as string[],
  artifactIds: [] as string[],
});
async function setup() {
  const account = await h.signup();
  const connection = await h.services.connections.create(account.ownerId, {
    name: 'workspace',
    adapter: 'direct',
    transport: 'http',
    mode: 'existing',
    url: upstream.url,
  });
  const [tool] = await h.services.connections.discover(account.ownerId, connection.id);
  const profile = (await h.services.profiles.save(account.ownerId, {
    name: 'Agent',
    requestable: { ...none(), toolIds: [tool!.id] },
  }))!;
  const key = await h.services.profiles.issue(account.ownerId, profile.id);
  const context = {
    ownerId: account.ownerId,
    profileId: profile.id,
    identity: key.id,
    credentialId: key.id,
    entry: 'gateway' as const,
    sessionId: randomUUID(),
    capabilities: {},
  };
  const access = { ownerId: account.ownerId, profileId: profile.id };
  return {
    account,
    connection,
    tool: tool!,
    profile,
    key,
    context,
    access,
    run: <T>(fn: () => T) => withExecution(context, fn),
  };
}
test('legacy update preserves new fields, increments revisions and rejects stale updates and forged call context', async () => {
  const s = await setup();
  const saved = await h.services.profiles.save(
    s.account.ownerId,
    { name: 'renamed' },
    s.profile.id,
  );
  expect(saved!.requestable).toEqual(s.profile.requestable);
  expect(saved!.revision).toBe(s.profile.revision + 1);
  expect(
    (
      await s.account.request(`/profiles/${s.profile.id}`, {
        method: 'PUT',
        body: JSON.stringify({ name: 'stale', revision: s.profile.revision }),
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await s.account.request(`/profiles/${s.profile.id}/agent/tools/${s.tool.id}/call`, {
        method: 'POST',
        body: JSON.stringify({ arguments: {}, profileId: randomUUID() }),
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await s.account.request(`/profiles/${s.profile.id}/agent/tools/${s.tool.id}/call`, {
        method: 'POST',
        body: '{"arguments":{}}',
      })
    ).status,
  ).toBe(403);
});
test('requestable is not executable; concurrent duplicate approval creates one credential-scoped grant and never dispatches', async () => {
  const s = await setup();
  const before = upstream.count();
  await expect(
    s.run(() => h.services.invocations.call({ ...s.access, toolId: s.tool.id, arguments: {} })),
  ).rejects.toThrow('未授权');
  const input = {
    permissions: { ...none(), toolIds: [s.tool.id] },
    reason: 'need echo',
    idempotencyKey: 'request-1',
  };
  const request = await s.run(() => h.services.requests.create(s.access, input));
  expect((await s.run(() => h.services.requests.create(s.access, input))).id).toBe(request.id);
  await expect(
    s.run(() => h.services.requests.create(s.access, { ...input, reason: 'different' })),
  ).rejects.toThrow('幂等键');
  const decisions = await Promise.all([
    h.services.requests.decide(s.account.ownerId, request.id, {
      decision: 'approved',
      permissions: input.permissions,
    }),
    h.services.requests.decide(s.account.ownerId, request.id, {
      decision: 'approved',
      permissions: input.permissions,
      expiresAt: new Date(Date.now() + 7200000).toISOString(),
    }),
  ]);
  expect(decisions[0]!.expiresAt).toEqual(decisions[1]!.expiresAt);
  const grants = await h.db
    .select()
    .from(temporaryGrants)
    .where(eq(temporaryGrants.requestId, request.id));
  expect(grants).toHaveLength(1);
  expect(upstream.count()).toBe(before);
  await s.run(() => h.services.invocations.call({ ...s.access, toolId: s.tool.id, arguments: {} }));
  expect(upstream.count()).toBe(before + 1);
  const otherKey = await h.services.profiles.issue(s.account.ownerId, s.profile.id);
  await withExecution(
    { ...s.context, identity: otherKey.id, credentialId: otherKey.id },
    async () =>
      expect(await h.services.profiles.catalog(s.account.ownerId, s.profile.id)).toHaveLength(0),
  );
});
test('approval only accepts requested subsets and rejects cross-account decisions', async () => {
  const s = await setup();
  const request = await s.run(() =>
    h.services.requests.create(s.access, {
      permissions: { ...none(), toolIds: [s.tool.id] },
      reason: 'subset',
      idempotencyKey: 'subset',
    }),
  );
  await expect(
    h.services.requests.decide(s.account.ownerId, request.id, {
      decision: 'approved',
      permissions: { ...none(), toolIds: ['unrequested'] },
    }),
  ).rejects.toThrow('范围');
  const other = await h.signup();
  await expect(
    h.services.requests.decide(other.ownerId, request.id, { decision: 'rejected' }),
  ).rejects.toThrow();
  await h.services.requests.decide(s.account.ownerId, request.id, {
    decision: 'approved',
    permissions: none(),
  });
  expect(
    await s.run(() => h.services.profiles.catalog(s.account.ownerId, s.profile.id)),
  ).toHaveLength(0);
});
test('revocation cancels only calls depending on the temporary grant and does not replay', async () => {
  const s = await setup();
  const request = await s.run(() =>
    h.services.requests.create(s.access, {
      permissions: { ...none(), toolIds: [s.tool.id] },
      reason: 'running',
      idempotencyKey: 'running',
    }),
  );
  await h.services.requests.decide(s.account.ownerId, request.id, {
    decision: 'approved',
    permissions: request.requested,
  });
  const [grant] = await h.db
    .select()
    .from(temporaryGrants)
    .where(eq(temporaryGrants.requestId, request.id));
  const before = upstream.count();
  const call = s.run(() =>
    h.services.invocations.call({ ...s.access, toolId: s.tool.id, arguments: { delay: 500 } }),
  );
  const rejected = expect(call).rejects.toThrow();
  await vi.waitFor(() => expect(upstream.count()).toBe(before + 1));
  await h.services.requests.revoke(s.account.ownerId, grant!.id);
  await rejected;
  expect(upstream.count()).toBe(before + 1);
});
test('grant expiration removes directory access while a long-term grant remains usable', async () => {
  const s = await setup();
  const request = await s.run(() =>
    h.services.requests.create(s.access, {
      permissions: { ...none(), toolIds: [s.tool.id] },
      reason: 'expiry',
      idempotencyKey: 'expiry',
    }),
  );
  await h.services.requests.decide(s.account.ownerId, request.id, {
    decision: 'approved',
    permissions: request.requested,
    expiresAt: new Date(Date.now() + 150).toISOString(),
  });
  await vi.waitFor(async () =>
    expect(
      await s.run(() => h.services.profiles.catalog(s.account.ownerId, s.profile.id)),
    ).toHaveLength(0),
  );
  await h.services.profiles.save(
    s.account.ownerId,
    { name: s.profile.name, toolIds: [s.tool.id] },
    s.profile.id,
  );
  expect(
    await s.run(() => h.services.profiles.catalog(s.account.ownerId, s.profile.id)),
  ).toHaveLength(1);
});
test.each(['rejected', 'cancelled'] as const)(
  'task waits for explicit %s without dispatch and task cancellation interrupts a wait',
  async (decision) => {
    const s = await setup();
    const taskId = randomUUID();
    await h.db
      .insert(tasks)
      .values({ id: taskId, ...s.access, prompt: 'permission fixture', status: 'running' });
    const context = {
      ...s.context,
      identity: `pi:${s.profile.id}`,
      credentialId: undefined,
      taskId,
      entry: 'pi' as const,
    };
    const abort = new AbortController();
    await withExecution(context, async () => {
      const request = await h.services.requests.create(s.access, {
        permissions: { ...none(), toolIds: [s.tool.id] },
        reason: 'wait',
        idempotencyKey: 'wait',
      });
      const before = upstream.count();
      const pending = h.services.requests.wait(s.access, request.id, abort.signal);
      await h.services.requests.decide(s.account.ownerId, request.id, { decision });
      expect((await pending).status).toBe(decision);
      expect(upstream.count()).toBe(before);
      const second = await h.services.requests.create(s.access, {
        permissions: { ...none(), toolIds: [s.tool.id] },
        reason: 'cancel task',
        idempotencyKey: 'second',
      });
      const waiting = h.services.requests.wait(s.access, second.id, abort.signal);
      const rejected = expect(waiting).rejects.toThrow();
      abort.abort(new Error('task cancelled'));
      await rejected;
    });
  },
);
test('policy changes and key revocation invalidate pending requests; restart interrupts task requests only', async () => {
  const s = await setup();
  const request = await s.run(() =>
    h.services.requests.create(s.access, {
      permissions: { ...none(), toolIds: [s.tool.id] },
      reason: 'revision',
      idempotencyKey: 'revision',
    }),
  );
  await h.services.profiles.save(s.account.ownerId, { name: 'new policy' }, s.profile.id);
  await h.services.requests.reconcile(s.profile.id);
  expect((await h.services.requests.owned(s.account.ownerId, request.id)).status).toBe(
    'invalidated',
  );
  const next = await s.run(() =>
    h.services.requests.create(s.access, {
      permissions: { ...none(), toolIds: [s.tool.id] },
      reason: 'key',
      idempotencyKey: 'key',
    }),
  );
  await h.services.profiles.revoke(s.account.ownerId, s.key.id);
  await h.services.access.changed();
  expect((await h.services.requests.owned(s.account.ownerId, next.id)).status).toBe('invalidated');
});
test('temporary content and resource template grants use the same scope and disappear on revoke', async () => {
  const s = await setup();
  const connection = await h.services.connections.create(s.account.ownerId, {
    name: 'content',
    adapter: 'direct',
    transport: 'http',
    mode: 'existing',
    url: catalog.url,
  });
  await h.services.connections.discover(s.account.ownerId, connection.id);
  const entries = await h.services.content.catalog({ ownerId: s.account.ownerId }, connection.id);
  const ids = entries.map((e) => e.id);
  await h.services.profiles.save(
    s.account.ownerId,
    { name: 'content', requestable: { ...none(), contentIds: ids } },
    s.profile.id,
  );
  const request = await s.run(() =>
    h.services.requests.create(s.access, {
      permissions: { ...none(), contentIds: ids },
      reason: 'content',
      idempotencyKey: 'content',
    }),
  );
  await expect(
    s.run(() =>
      h.services.content.read({ ...s.access, uri: scopedUri(connection.id, 'note:///one') }),
    ),
  ).rejects.toThrow('未授权');
  await h.services.requests.decide(s.account.ownerId, request.id, {
    decision: 'approved',
    permissions: request.requested,
  });
  expect(
    (
      await s.run(() =>
        h.services.content.read({ ...s.access, uri: scopedUri(connection.id, 'note:///one') }),
      )
    ).contents,
  ).toHaveLength(1);
  const prompt = entries.find((entry) => entry.kind === 'prompt')!;
  expect(
    await s.run(() =>
      h.services.content.prompt({
        ...s.access,
        id: prompt.id,
        arguments: { subject: 'temporary' },
      }),
    ),
  ).toHaveProperty('messages');
  const { entry, original } = await s.run(() =>
    h.services.content.resolveResource(s.access, scopedUri(connection.id, 'note:///one')),
  );
  const revoked = vi.fn();
  const release = await s.run(() => h.services.content.subscribe(entry, original, revoked));
  const [grant] = await h.db
    .select()
    .from(temporaryGrants)
    .where(eq(temporaryGrants.requestId, request.id));
  await h.services.requests.revoke(s.account.ownerId, grant!.id);
  expect(revoked).toHaveBeenCalledOnce();
  await release();
  await expect(
    s.run(() =>
      h.services.content.read({ ...s.access, uri: scopedUri(connection.id, 'note:///one') }),
    ),
  ).rejects.toThrow('未授权');
});

test('request catalog contains only opened capabilities with sources and explicit request deadlines become expired', async () => {
  const s = await setup();
  const directory = (await s.run(() => h.services.requests.catalog(s.access))) as {
    toolIds: string[];
    entries: { tools: { name: string; exposedName: string }[]; connections: { id: string }[] };
  };
  expect(directory.toolIds).toEqual([s.tool.id]);
  expect(directory.entries.tools[0]!.name).toBe('echo');
  expect(directory.entries.tools[0]!.exposedName).toBe('workspace__echo');
  expect(directory.entries.connections[0]!.id).toBe(s.connection.id);
  const request = await s.run(() =>
    h.services.requests.create(s.access, {
      permissions: { ...none(), toolIds: [s.tool.id] },
      reason: 'deadline',
      idempotencyKey: 'deadline',
      deadline: new Date(Date.now() + 150).toISOString(),
    }),
  );
  await vi.waitFor(async () =>
    expect(
      (await h.services.requests.list(s.account.ownerId)).find((row) => row.id === request.id)!
        .status,
    ).toBe('expired'),
  );
});

test('revoking a redundant temporary grant preserves a running call authorized permanently', async () => {
  const s = await setup();
  await h.services.profiles.save(
    s.account.ownerId,
    { name: 'long term', toolIds: [s.tool.id] },
    s.profile.id,
  );
  const request = await s.run(() =>
    h.services.requests.create(s.access, {
      permissions: { ...none(), toolIds: [s.tool.id] },
      reason: 'redundant',
      idempotencyKey: 'redundant',
    }),
  );
  await h.services.requests.decide(s.account.ownerId, request.id, {
    decision: 'approved',
    permissions: request.requested,
  });
  const [grant] = await h.db
    .select()
    .from(temporaryGrants)
    .where(eq(temporaryGrants.requestId, request.id));
  const before = upstream.count();
  const call = s.run(() =>
    h.services.invocations.call({ ...s.access, toolId: s.tool.id, arguments: { delay: 500 } }),
  );
  await vi.waitFor(() => expect(upstream.count()).toBe(before + 1));
  await h.services.requests.revoke(s.account.ownerId, grant!.id);
  expect(await call).toHaveProperty('content');
  expect(upstream.count()).toBe(before + 1);
});

test('external MCP request tools return approval state and require a fresh explicit business dispatch', async () => {
  const { Client, StreamableHTTPClientTransport } = await import('@modelcontextprotocol/client');
  const s = await setup();
  const client = new Client({ name: 'permission-client', version: '1' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${h.baseURL}/mcp/${s.profile.id}`), {
      requestInit: { headers: { Authorization: `Bearer ${s.key.token}` } },
    }),
  );
  try {
    expect((await client.listTools()).tools.map((tool) => tool.name)).toContain(
      'platform_permissions_request',
    );
    const before = upstream.count();
    const result = await client.callTool({
      name: 'platform_permissions_request',
      arguments: {
        permissions: { ...none(), toolIds: [s.tool.id] },
        reason: 'external approval',
        idempotencyKey: 'external',
      },
    });
    const request = JSON.parse(String((result.content as { text: string }[])[0]!.text)) as {
      id: string;
      requested: ReturnType<typeof none>;
    };
    await h.services.requests.decide(s.account.ownerId, request.id, {
      decision: 'approved',
      permissions: request.requested,
    });
    expect(upstream.count()).toBe(before);
    const listed = (await client.listTools()).tools.map((tool) => tool.name);
    expect(listed).toContain('workspace__echo');
    expect(listed).not.toContain(s.tool.id);
    await client.callTool({ name: 'workspace__echo', arguments: {} });
    expect(upstream.count()).toBe(before + 1);
  } finally {
    await client.close();
  }
});

test('task restart invalidates task-scoped grants and pending waits while keeping unexpired credential grants', async () => {
  const s = await setup();
  const permissions = { ...none(), toolIds: [s.tool.id] };
  const external = await s.run(() =>
    h.services.requests.create(s.access, {
      permissions,
      reason: 'durable credential',
      idempotencyKey: 'durable',
    }),
  );
  await h.services.requests.decide(s.account.ownerId, external.id, {
    decision: 'approved',
    permissions,
  });
  const taskId = randomUUID();
  await h.db
    .insert(tasks)
    .values({ id: taskId, ...s.access, prompt: 'interrupted task', status: 'running' });
  const context = {
    ...s.context,
    identity: `pi:${s.profile.id}`,
    credentialId: undefined,
    taskId,
    entry: 'pi' as const,
  };
  const pending = await withExecution(context, () =>
    h.services.requests.create(s.access, {
      permissions,
      reason: 'task approval',
      idempotencyKey: 'task',
    }),
  );
  await h.services.pi.recover();
  await h.services.requests.recover();
  expect((await h.services.requests.owned(s.account.ownerId, pending.id)).status).toBe(
    'interrupted',
  );
  expect(
    await s.run(() => h.services.profiles.catalog(s.account.ownerId, s.profile.id)),
  ).toHaveLength(1);
  await expect(
    withExecution(context, () => h.services.profiles.catalog(s.account.ownerId, s.profile.id)),
  ).rejects.toThrow('任务已结束');
});
