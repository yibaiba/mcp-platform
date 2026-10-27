import { afterAll, beforeAll, expect, test } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { Client as LegacyClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport as LegacyTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { serve } from '@hono/node-server';
import { eq } from 'drizzle-orm';
import {
  accessKeys,
  authorizationBindings,
  tasks,
  temporaryGrants,
} from '../packages/db/src/index.js';
import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { withExecution } from '../apps/server/src/modules/mcp/executionContext.js';
import { harness } from './harness.js';

let h: Awaited<ReturnType<typeof harness>>;
let api: ReturnType<typeof serve>;
let url: string;
let dispatched = 0;
const content = 'generated binary report';
beforeAll(async () => {
  h = await harness();
  api = serve({
    port: 0,
    fetch: () => {
      dispatched++;
      return new Response(content, { headers: { 'Content-Type': 'application/octet-stream' } });
    },
  });
  await new Promise<void>((resolve) => api.once('listening', resolve));
  const address = api.address();
  if (!address || typeof address === 'string') throw new Error('Missing HTTP address');
  url = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
  await h?.close();
  await new Promise<void>((resolve) => api?.close(() => resolve()));
});
async function setup() {
  const account = await h.signup();
  const connection = await h.services.connections.create(account.ownerId, {
    name: 'Export API',
    source: 'openapi',
    adapter: 'direct',
    transport: 'http',
    mode: 'existing',
    openapi: {
      baseUrl: url,
      operations: ['GET /report'],
      document: {
        openapi: '3.1.0',
        info: { title: 'Export API', version: '1' },
        paths: { '/report': { get: { responses: { '200': { description: 'Report' } } } } },
      },
    },
  });
  const [tool] = await h.services.connections.discover(account.ownerId, connection.id);
  const profile = (await h.services.profiles.save(account.ownerId, {
    name: 'Report Agent',
    toolIds: [tool!.id],
  }))!;
  const a = await h.services.profiles.issue(account.ownerId, profile.id);
  const b = await h.services.profiles.issue(account.ownerId, profile.id);
  return { account, connection, tool: tool!, profile, a, b };
}
const payload = (result: unknown) =>
  JSON.parse((result as { content: { text: string }[] }).content[0]!.text);
test.each([false, true])(
  'generated output is readable only by its producer and expires without replay (legacy=%s)',
  async (legacy) => {
    const { account, tool, profile, a, b } = await setup();
    const endpoint = new URL(`${h.baseURL}/mcp/${profile.id}`);
    const requestInit = { headers: { Authorization: `Bearer ${a.token}` } };
    const client = legacy
      ? new LegacyClient({ name: 'output-reader', version: '1' })
      : new Client({ name: 'output-reader', version: '1' });
    const transport = legacy
      ? new LegacyTransport(endpoint, { requestInit })
      : new StreamableHTTPClientTransport(endpoint, { requestInit });
    // Each branch uses its matching SDK transport; the union signatures are compatible at runtime.
    if (legacy) await (client as LegacyClient).connect(transport as LegacyTransport);
    else await (client as Client).connect(transport as StreamableHTTPClientTransport);
    const before = dispatched;
    try {
      expect((await client.listTools()).tools.map((t) => t.name)).toContain(
        'platform_artifacts_read',
      );
      const result = await client.callTool({ name: tool.id, arguments: {} });
      const id = String(
        (result as { structuredContent?: { artifactId?: string } }).structuredContent?.artifactId,
      );
      const read = {
        name: 'platform_artifacts_read',
        arguments: { id, offset: 0, length: content.length, encoding: 'utf8' },
      };
      expect(payload(await client.callTool(read)).data).toBe(content);
      const catalog = payload(
        await client.callTool({ name: 'platform_artifacts_catalog', arguments: {} }),
      );
      expect(catalog).toHaveLength(1);
      const download = (token: string) =>
        h.app.request(catalog[0].downloadPath, {
          headers: { Authorization: `Bearer ${token}` },
        });
      expect(await (await download(a.token)).text()).toBe(content);
      expect((await download(b.token)).status).toBe(403);
      const grants = await h.services.requests.grants(account.ownerId);
      expect(grants).toHaveLength(1);
      expect(grants[0]).toMatchObject({ subject: `credential:${a.id}`, requestId: null });
      expect(grants[0]!.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(60 * 60_000);
      await h.db
        .update(temporaryGrants)
        .set({ expiresAt: new Date(0) })
        .where(eq(temporaryGrants.id, grants[0]!.id));
      await expect(client.callTool(read)).rejects.toThrow();
      expect((await download(a.token)).status).toBe(403);
      expect(dispatched - before).toBe(1);
    } finally {
      await client.close();
    }
  },
);

test.each(['profile', 'credential', 'binding'] as const)(
  'output storage rejects a changed %s scope and leaves no file or grant',
  async (change) => {
    const { account, connection, profile, a } = await setup();
    await withExecution(
      {
        ownerId: account.ownerId,
        profileId: profile.id,
        credentialId: a.id,
        identity: a.id,
        entry: 'gateway',
        sessionId: 'output-test',
        capabilities: {},
      },
      async () => {
        const write = await h.services.artifacts.resultWriter(account.ownerId, connection.id);
        const before = await readdir(join(h.directory, 'artifacts')).catch(
          (error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') return [];
            throw error;
          },
        );
        if (change === 'profile')
          await h.services.profiles.save(account.ownerId, { name: 'Changed' }, profile.id);
        if (change === 'credential')
          await h.db.update(accessKeys).set({ revoked: true }).where(eq(accessKeys.id, a.id));
        if (change === 'binding') {
          const context = await h.services.connections.context(account.ownerId, connection.id);
          await h.services.connections.bindings.invalidate(context);
        }
        await expect(
          write({ name: 'interrupted.bin', body: new Response(content).body }),
        ).rejects.toThrow();
        expect(await h.services.artifacts.list(account.ownerId)).toEqual([]);
        expect(await h.services.requests.grants(account.ownerId)).toEqual([]);
        expect(await readdir(join(h.directory, 'artifacts'))).toEqual(before);
      },
    );
  },
);

test('Pi output grants stay with the producing task and end with that task', async () => {
  const { account, connection, profile } = await setup();
  const ids = [randomUUID(), randomUUID()];
  await h.db.insert(tasks).values(
    ids.map((id) => ({
      id,
      ownerId: account.ownerId,
      profileId: profile.id,
      prompt: 'output scope',
      status: 'running',
    })),
  );
  const caller = { ownerId: account.ownerId, profileId: profile.id };
  const context = (id: string) => ({
    ...caller,
    taskId: id,
    identity: `pi:${profile.id}`,
    entry: 'pi' as const,
    sessionId: id,
    capabilities: {},
  });
  const file = await withExecution(context(ids[0]!), async () => {
    const write = await h.services.artifacts.resultWriter(account.ownerId, connection.id);
    const row = await write({ name: 'task-output.bin', body: new Response(content).body });
    await h.services.access.assert(caller, 'artifactIds', row.id);
    return row;
  });
  expect(
    await withExecution(context(ids[1]!), () =>
      h.services.access.allows(caller, 'artifactIds', file.id),
    ),
  ).toBe(false);
  await h.db.update(tasks).set({ status: 'succeeded' }).where(eq(tasks.id, ids[0]!));
  await expect(
    withExecution(context(ids[0]!), () => h.services.access.assert(caller, 'artifactIds', file.id)),
  ).rejects.toThrow('任务已结束');
});

test('revoking the output binding leaves unrelated permanent artifact permissions usable', async () => {
  const { account, connection, profile, tool, a } = await setup();
  const permanent = await h.services.artifacts.store(account.ownerId, {
    name: 'permanent.txt',
    body: new Response('permanent').body,
  });
  await h.services.profiles.save(
    account.ownerId,
    {
      name: profile.name,
      toolIds: [tool.id],
      artifactIds: [permanent.id],
    },
    profile.id,
  );
  await withExecution(
    {
      ownerId: account.ownerId,
      profileId: profile.id,
      credentialId: a.id,
      identity: a.id,
      entry: 'gateway',
      sessionId: 'revocation-test',
      capabilities: {},
    },
    async () => {
      const write = await h.services.artifacts.resultWriter(account.ownerId, connection.id);
      const output = await write({ name: 'result.bin', body: new Response(content).body });
      const context = await h.services.connections.context(account.ownerId, connection.id);
      await h.db
        .update(authorizationBindings)
        .set({ revoked: true })
        .where(eq(authorizationBindings.id, context.bindingId!));
      const caller = { ownerId: account.ownerId, profileId: profile.id };
      expect(await h.services.access.allows(caller, 'artifactIds', output.id)).toBe(false);
      expect(await h.services.access.allows(caller, 'artifactIds', permanent.id)).toBe(true);
    },
  );
});
