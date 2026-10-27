import { afterAll, beforeAll, expect, test } from 'vitest';
import { harness } from './harness.js';
import { fixtureMcp, createFixtureMcpServer } from './fixtureMcp.js';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { connectionInput } from '../packages/contracts/src/index.js';
import {
  currentExecution,
  sessionScope,
  withExecution,
} from '../apps/server/src/modules/mcp/executionContext.js';
let h: Awaited<ReturnType<typeof harness>>;
let upstream: Awaited<ReturnType<typeof fixtureMcp>>;
beforeAll(async () => {
  h = await harness();
  upstream = await fixtureMcp();
});
afterAll(async () => {
  await h?.close();
  await upstream?.close();
});
const caller = (identity: string, sessionId = 'session') => ({
  identity,
  sessionId,
  entry: 'gateway' as const,
  capabilities: {},
});
test('real upstream catalogs and requests keep identities, selected headers and cookies separate', async () => {
  const requests: { tenant?: string; cookie?: string; authorization?: string }[] = [];
  const sessions = new Set<ReturnType<typeof createFixtureMcpServer>>();
  const app = new Hono();
  app.all('/mcp', async (c) => {
    const tenant = c.req.header('X-Tenant');
    requests.push({
      tenant,
      cookie: c.req.header('Cookie'),
      authorization: c.req.header('Authorization'),
    });
    const server = createFixtureMcpServer(() => {});
    sessions.add(server);
    server.onclose = () => sessions.delete(server);
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: `tenant-${tenant}`,
          inputSchema: { type: 'object', properties: { tenant: { const: tenant } } },
        },
      ],
    }));
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    c.header('Set-Cookie', `upstream-identity=${tenant}; Path=/`);
    return transport.handleRequest(c.req.raw);
  });
  const http = serve({ port: 0, fetch: app.fetch });
  await new Promise<void>((resolve) => http.once('listening', resolve));
  const address = http.address();
  if (!address || typeof address === 'string') throw new Error('No upstream address');
  const account = await h.signup();
  const connection = await h.services.connections.create(account.ownerId, {
    name: 'Real tenants',
    adapter: 'direct',
    transport: 'http',
    mode: 'existing',
    url: `http://127.0.0.1:${address.port}/mcp`,
    identityMode: 'independent',
    forwardHeaders: ['X-Tenant'],
    lifecycle: { startup: 'on-demand' },
  });
  const context = (tenant: string) => ({
    ...caller(`key-${tenant}`),
    headers: {
      'x-tenant': tenant,
      cookie: 'platform-login-cookie',
      authorization: 'platform-access-token',
    },
  });
  try {
    const catalogs = await Promise.all(
      ['a', 'b'].map((tenant) =>
        withExecution(context(tenant), () =>
          h.services.connections.discover(account.ownerId, connection.id),
        ),
      ),
    );
    for (const tenant of ['a', 'b']) {
      const tools = await withExecution(context(tenant), () =>
        h.services.profiles.catalog(account.ownerId),
      );
      expect(tools.map((tool) => tool.name)).toEqual([`tenant-${tenant}`]);
      expect(tools[0]!.definition.inputSchema).toMatchObject({
        properties: { tenant: { const: tenant } },
      });
    }
    const before = requests.length;
    await expect(
      withExecution(context('b'), () =>
        h.services.invocations.call({
          ownerId: account.ownerId,
          toolId: catalogs[0]![0]!.id,
          arguments: {},
        }),
      ),
    ).rejects.toThrow(/未授权/);
    expect(requests).toHaveLength(before);
    expect(new Set(requests.map((request) => request.tenant))).toEqual(new Set(['a', 'b']));
    expect(
      requests.every(
        (request) => request.cookie === undefined && request.authorization === undefined,
      ),
    ).toBe(true);
  } finally {
    await h.services.connections.stop(account.ownerId, connection.id);
    await Promise.all([...sessions].map((session) => session.close()));
    await new Promise<void>((resolve) => http.close(() => resolve()));
  }
});
test('credentials bind to stable identity while sessions and selected headers isolate runtime instances', async () => {
  const account = await h.signup();
  const created = await h.services.connections.create(account.ownerId, {
    name: 'Independent',
    adapter: 'direct',
    transport: 'http',
    mode: 'existing',
    url: upstream.url,
    identityMode: 'independent',
    forwardHeaders: ['X-Tenant'],
  });
  const get = (identity: string, sessionId: string, tenant = 'a') =>
    withExecution(
      {
        ...caller(identity, sessionId),
        headers: {
          'x-tenant': tenant,
          authorization: 'must-not-forward',
          cookie: 'must-not-forward',
        },
      },
      () => h.services.connections.context(account.ownerId, created.id),
    );
  const [a, b, a2, a3] = await Promise.all([
    get('key-a', 'one'),
    get('key-b', 'one'),
    get('key-a', 'two'),
    get('key-a', 'one', 'b'),
  ]);
  expect(a.bindingId).not.toBe(b.bindingId);
  expect(a.bindingId).toBe(a2.bindingId);
  expect(a.runtimeKey).not.toBe(a2.runtimeKey);
  expect(a.runtimeKey).not.toBe(a3.runtimeKey);
  expect(a.config.headers).toEqual({ 'x-tenant': 'a' });
  await withExecution(caller('key-a'), () =>
    h.services.connections.discover(account.ownerId, created.id),
  );
  expect(
    await withExecution(caller('key-b'), () =>
      h.services.connections.snapshot(account.ownerId, created.id),
    ),
  ).toBeUndefined();
  expect(
    (
      await withExecution(caller('key-a'), () =>
        h.services.connections.snapshot(account.ownerId, created.id),
      )
    )?.tools,
  ).toHaveLength(1);
  await h.services.connections.stop(account.ownerId, created.id);
  expect(await h.services.profiles.catalog(account.ownerId)).toEqual([]);
  expect(await h.services.content.catalog({ ownerId: account.ownerId })).toEqual([]);
});
test('legacy configuration retains its shared authorization and identity survives token refresh', async () => {
  const account = await h.signup();
  const { id } = await h.services.connections.create(account.ownerId, {
    name: 'Shared',
    adapter: 'direct',
    transport: 'http',
    mode: 'existing',
    url: upstream.url,
  });
  const a = await withExecution(caller('grant-a'), () =>
    h.services.connections.context(account.ownerId, id),
  );
  const b = await withExecution(caller('key-b'), () =>
    h.services.connections.context(account.ownerId, id),
  );
  expect(a.bindingId).toBe(b.bindingId);
  expect(a.identity).toBe('default');
  expect(a.runtimeKey).not.toBe(b.runtimeKey);
});
test('async execution contexts do not leak across concurrent identities', async () => {
  await Promise.all(
    ['a', 'b'].map((identity) =>
      withExecution(caller(identity), async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        expect(currentExecution()?.identity).toBe(identity);
      }),
    ),
  );
  expect(currentExecution()).toBeUndefined();
});
test.each(['eager', 'on-demand'] as const)(
  '%s catalog access follows startup policy while explicit wake is coalesced',
  async (startup) => {
    const account = await h.signup();
    const { id } = await h.services.connections.create(account.ownerId, {
      name: startup,
      adapter: 'direct',
      transport: 'http',
      mode: 'existing',
      url: upstream.url,
      lifecycle: { startup },
    });
    await withExecution(caller('startup'), async () => {
      const [first, second] = await Promise.all([
        h.services.connections.wake(account.ownerId, id),
        h.services.connections.wake(account.ownerId, id),
      ]);
      expect(first.map((t) => t.id)).toEqual(second.map((t) => t.id));
      expect((await h.services.connections.list(account.ownerId))[0]!.sessions).toHaveLength(1);
      await h.services.connections.close(account.ownerId, id);
      expect(
        (await h.services.connections.catalogForAccess(account.ownerId, id))?.tools,
      ).toHaveLength(1);
      expect((await h.services.connections.list(account.ownerId))[0]!.sessions).toHaveLength(
        startup === 'eager' ? 1 : 0,
      );
      await h.services.connections.sleep(account.ownerId, id);
      await h.services.connections.catalogForAccess(account.ownerId, id);
      expect((await h.services.connections.list(account.ownerId))[0]!.sessions).toHaveLength(0);
      const before = upstream.count();
      await h.services.invocations.call({
        ownerId: account.ownerId,
        toolId: first[0]!.id,
        arguments: { message: 'wake on use' },
      });
      expect(upstream.count() - before).toBe(1);
    });
  },
);
test('capability keys are canonical and only explicitly mapped headers affect session identity', () => {
  const config = connectionInput.parse({
    name: 'Headers',
    adapter: 'direct',
    transport: 'http',
    mode: 'existing',
    url: 'https://example.com/mcp',
    forwardHeaders: ['X-Tenant'],
  });
  const a = withExecution(
    { ...caller('a'), capabilities: { a: {}, b: {} }, headers: { ignored: 'one' } },
    () => sessionScope(config),
  );
  const b = withExecution(
    { ...caller('a'), capabilities: { b: {}, a: {} }, headers: { ignored: 'two' } },
    () => sessionScope(config),
  );
  expect(a).toEqual(b);
  for (const header of ['Cookie', 'Authorization', 'Mcp-Session-Id', 'Host'])
    expect(() => connectionInput.parse({ ...config, forwardHeaders: [header] })).toThrow();
});
