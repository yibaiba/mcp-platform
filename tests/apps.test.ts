import { tasks, temporaryGrants } from '../packages/db/src/index.js';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { harness } from './harness.js';
import { fixtureApp } from './fixtureApp.js';
import { sandboxApp } from '../apps/server/src/modules/apps/sandbox.js';
import { scopedUri } from '../apps/server/src/modules/mcp/catalogEntries.js';
import {
  withExecution,
  PLATFORM_CAPABILITIES,
} from '../apps/server/src/modules/mcp/executionContext.js';
let h: Awaited<ReturnType<typeof harness>>;
let upstream: Awaited<ReturnType<typeof fixtureApp>>;
beforeAll(async () => {
  h = await harness();
  upstream = await fixtureApp();
});
afterAll(async () => {
  await h?.close();
  await upstream?.close();
});
async function setup() {
  const account = await h.signup();
  const connection = await h.services.connections.create(account.ownerId, {
    name: 'Apps',
    adapter: 'direct',
    transport: 'http',
    mode: 'existing',
    url: upstream.url,
  });
  const tools = await h.services.connections.discover(account.ownerId, connection.id);
  const entries = await h.services.content.catalog({ ownerId: account.ownerId });
  const profile = (await h.services.profiles.save(account.ownerId, {
    name: 'Apps',
    toolIds: tools.map((t) => t.id),
    contentIds: entries.map((e) => e.id),
  }))!;
  return { account, connection, tools, profile };
}
test('Apps preserve ui URI namespaces and visibility for official external clients without spawning platform views', async () => {
  const { account, connection, profile, tools } = await setup();
  const key = await h.services.profiles.issue(account.ownerId, profile.id);
  const client = new Client(
    { name: 'App client', version: '1' },
    { capabilities: PLATFORM_CAPABILITIES },
  );
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${h.baseURL}/mcp/${profile.id}`), {
      requestInit: { headers: { Authorization: `Bearer ${key.token}` } },
    }),
  );
  try {
    const catalog = await client.listTools();
    expect(
      catalog.tools.find((t) => t.name === tools.find((t) => t.name === 'show')!.id)?._meta,
    ).toMatchObject({ ui: { resourceUri: scopedUri(connection.id, upstream.uri) } });
    expect((await client.listResources()).resources[0]?.uri).toMatch(/^ui:\/\//);
    await client.callTool({ name: tools.find((t) => t.name === 'show')!.id, arguments: {} });
    expect(h.services.apps.list(account.ownerId)).toHaveLength(0);
  } finally {
    await client.close();
  }
});
test('platform App calls use current grants and end on refresh without replaying the original tool', async () => {
  const { account, connection, profile, tools } = await setup();
  const execution = {
    identity: `pi:${profile.id}`,
    entry: 'pi' as const,
    taskId: crypto.randomUUID(),
    ownerId: account.ownerId,
    profileId: profile.id,
    sessionId: 'test',
    capabilities: PLATFORM_CAPABILITIES,
  };
  await h.db.insert(tasks).values({
    id: execution.taskId,
    ownerId: account.ownerId,
    profileId: profile.id,
    prompt: 'App host fixture',
    status: 'running',
  });
  const result = await withExecution(execution, () =>
    h.services.invocations.call({
      ownerId: account.ownerId,
      profileId: profile.id,
      toolId: tools.find((t) => t.name === 'show')!.id,
      arguments: {},
    }),
  );
  const id = result._meta!['platform/appSession'] as string;
  const before = upstream.calls();
  expect((await h.services.apps.view(account.ownerId, id)).resource.contents[0]?.uri).toBe(
    scopedUri(connection.id, upstream.uri),
  );
  await expect(h.services.apps.view('another-owner', id)).rejects.toThrow(/已结束/);
  const cancelled = AbortSignal.abort(new Error('App caller cancelled'));
  await expect(
    h.services.apps.call(account.ownerId, id, { name: 'app_action', signal: cancelled }),
  ).rejects.toThrow(/cancel|abort/i);
  expect(upstream.calls()).toBe(before);
  await h.services.apps.call(account.ownerId, id, { name: 'app_action' });
  expect(upstream.calls()).toBe(before + 1);
  expect(h.services.apps.list(account.ownerId)).toHaveLength(1);
  await expect(h.services.apps.call(account.ownerId, id, { name: 'model_only' })).rejects.toThrow(
    /未授权/,
  );
  await h.services.profiles.save(
    account.ownerId,
    { name: 'revoked', toolIds: tools.map((t) => t.id), contentIds: [] },
    profile.id,
  );
  await expect(h.services.apps.call(account.ownerId, id, { name: 'app_action' })).rejects.toThrow(
    /未授权/,
  );
  expect(upstream.calls()).toBe(before + 1);
  h.services.apps.close(account.ownerId, id);
  await expect(h.services.apps.view(account.ownerId, id)).rejects.toThrow(/已结束/);
});
test('sandbox serves one-use documents for the opaque proxy and enforces declared CSP', async () => {
  const app = sandboxApp(['https://platform.example'], 'https://platform.example');
  const denied = await app.request('/frames', {
    method: 'POST',
    headers: { Origin: 'https://evil.example' },
    body: JSON.stringify({ html: 'bad' }),
  });
  expect(denied.status).toBe(403);
  const response = await app.request('/frames', {
    method: 'POST',
    headers: { Origin: 'null', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      html: '<p>actual</p>',
      csp: { connectDomains: ['https://api.example'] },
    }),
  });
  expect(response.status).toBe(200);
  const { path } = (await response.json()) as { path: string };
  const frame = await app.request(path);
  expect(await frame.text()).toBe('<p>actual</p>');
  expect(frame.headers.get('Content-Security-Policy')).toContain('connect-src https://api.example');
  expect(frame.headers.get('Content-Security-Policy')).toContain(
    'sandbox allow-scripts allow-forms',
  );
  expect((await app.request(path)).status).toBe(410);
  expect((await app.request('/sandbox?parent=https://evil.example')).status).toBe(403);
  expect(
    (await app.request('/sandbox?parent=https://platform.example')).headers.get(
      'Content-Security-Policy',
    ),
  ).toContain("script-src 'sha256-");
});
test('mounting the sandbox does not expose management APIs to null origins', async () => {
  const response = await h.app.request('/api/v1/connections', {
    method: 'OPTIONS',
    headers: { Origin: 'null', 'Access-Control-Request-Method': 'GET' },
  });
  expect(response.headers.get('Access-Control-Allow-Origin')).not.toBe('null');
  const nested = await h.app.request('/_apps/api/v1/connections', {
    headers: { Origin: 'null' },
  });
  expect(nested.status).toBe(404);
  expect(nested.headers.get('Access-Control-Allow-Origin')).toBeNull();
});
test('call event streams expose only the authenticated owner and release their subscription on disconnect', async () => {
  const account = await h.signup();
  const response = await account.request('/calls/events');
  const reader = response.body!.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toContain('event: ready');
  const next = reader.read();
  h.services.events.publish({ ownerId: 'someone-else', kind: 'call', id: 'secret' });
  h.services.events.publish({
    ownerId: account.ownerId,
    kind: 'call',
    id: 'own-call',
    status: 'waiting',
  });
  const received = new TextDecoder().decode((await next).value);
  expect(received).toContain('own-call');
  expect(received).not.toContain('secret');
  await reader.cancel();
});

test('temporary App UI resources and app-only tools are authorized separately and revocation ends the view', async () => {
  const s = await setup();
  const entries = await h.services.content.catalog({ ownerId: s.account.ownerId });
  const show = s.tools.find((tool) => tool.name === 'show')!;
  await h.services.profiles.save(
    s.account.ownerId,
    {
      name: 'temporary UI',
      toolIds: [show.id],
      requestable: {
        toolIds: s.tools.map((tool) => tool.id),
        contentIds: entries.map((entry) => entry.id),
        artifactIds: [],
      },
    },
    s.profile.id,
  );
  const taskId = crypto.randomUUID();
  await h.db.insert(tasks).values({
    id: taskId,
    ownerId: s.account.ownerId,
    profileId: s.profile.id,
    prompt: 'temporary App',
    status: 'running',
  });
  await withExecution(
    {
      ownerId: s.account.ownerId,
      profileId: s.profile.id,
      identity: `pi:${s.profile.id}`,
      taskId,
      entry: 'pi',
      sessionId: taskId,
      capabilities: PLATFORM_CAPABILITIES,
    },
    async () => {
      const access = { ownerId: s.account.ownerId, profileId: s.profile.id };
      const directory = (await h.services.requests.catalog(access)) as { toolIds: string[] };
      expect(directory.toolIds).not.toContain(
        s.tools.find((tool) => tool.name === 'app_action')!.id,
      );
      const request = await h.services.requests.create(access, {
        permissions: { toolIds: [], contentIds: entries.map((entry) => entry.id), artifactIds: [] },
        reason: 'App UI only',
        idempotencyKey: 'app',
      });
      await h.services.requests.decide(s.account.ownerId, request.id, {
        decision: 'approved',
        permissions: request.requested,
      });
      const result = await h.services.invocations.call({
        ...access,
        toolId: show.id,
        arguments: {},
      });
      const id = String(result._meta!['platform/appSession']);
      const before = upstream.calls();
      await expect(
        h.services.apps.call(s.account.ownerId, id, { name: 'app_action' }),
      ).rejects.toThrow('未授权');
      expect(upstream.calls()).toBe(before);
      const [grant] = await h.db
        .select()
        .from(temporaryGrants)
        .where(eq(temporaryGrants.requestId, request.id));
      await h.services.requests.revoke(s.account.ownerId, grant!.id);
      expect(h.services.apps.list(s.account.ownerId, taskId)).toHaveLength(0);
      await expect(h.services.apps.view(s.account.ownerId, id)).rejects.toThrow('已结束');
    },
  );
});
