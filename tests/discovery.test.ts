import { afterAll, beforeAll, expect, test } from 'vitest';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { and, eq } from 'drizzle-orm';
import { toolVectors } from '../packages/db/src/index.js';
import { embeddingConfig } from '../packages/contracts/src/index.js';
import {
  EmbeddingClient,
  cosine,
  normalize,
} from '../apps/server/src/modules/discovery/embeddingClient.js';
import { harness } from './harness.js';
import { fixtureMcp } from './fixtureMcp.js';
let h: Awaited<ReturnType<typeof harness>>;
let upstream: Awaited<ReturnType<typeof fixtureMcp>>;
let embedding: ReturnType<typeof serve>;
let baseUrl: string;
const batches: string[][] = [];
let httpStatus = 200;
let duringQuery: (() => Promise<void>) | undefined;
beforeAll(async () => {
  h = await harness();
  upstream = await fixtureMcp();
  const app = new Hono();
  app.post('/v1/embeddings', async (c) => {
    const body = await c.req.json();
    batches.push(body.input);
    expect(body.encoding_format).toBe('float');
    if (httpStatus !== 200) return c.json({ error: 'private provider error' }, 503);
    if (body.input[0] === 'revoke') await duringQuery?.();
    return c.json({
      data: body.input
        .map((_: string, index: number) => ({ index, embedding: [1, 2, 3] }))
        .reverse(),
    });
  });
  embedding = serve({ port: 0, fetch: app.fetch });
  await new Promise<void>((resolve) => embedding.once('listening', resolve));
  const addr = embedding.address();
  if (!addr || typeof addr === 'string') throw new Error('No embedding address');
  baseUrl = `http://localhost:${addr.port}/v1`;
});
afterAll(async () => {
  await h?.close();
  await upstream?.close();
  await new Promise<void>((resolve, reject) =>
    embedding?.close((e) => (e ? reject(e) : resolve())),
  );
});
async function setup() {
  const owner = await h.signup();
  const connection = await h.services.connections.create(owner.ownerId, {
    name: 'search',
    adapter: 'direct',
    mode: 'existing',
    transport: 'http',
    url: upstream.url,
  });
  const [tool] = await h.services.connections.discover(owner.ownerId, connection.id);
  const profile = (await h.services.profiles.save(owner.ownerId, {
    name: 'search profile',
    toolIds: [tool!.id],
    discoveryMode: 'search',
    embedding: { baseUrl, model: 'protocol-fixture' },
    catalog: { tools: { [tool!.id]: { alias: 'public_echo', hiddenParameters: ['delay'] } } },
  }))!;
  return { ...owner, connection, tool: tool!, profile };
}
test('real MCP client receives search tools, retrieves authorized definitions and invokes once through the original path', async () => {
  const { ownerId, profile, tool } = await setup();
  const key = await h.services.profiles.issue(ownerId, profile.id);
  const client = new Client({ name: 'search-client', version: '1' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${h.baseURL}/mcp/${profile.id}`), {
      requestInit: { headers: { Authorization: `Bearer ${key.token}` } },
    }),
  );
  try {
    expect((await client.listTools()).tools.map((row) => row.name)).toEqual([
      'platform_tools_search',
      'platform_tools_definition',
      'platform_tools_call',
    ]);
    const found = await client.callTool({
      name: 'platform_tools_search',
      arguments: { query: 'echo' },
    });
    expect(JSON.stringify(found)).toContain(tool.id);
    const definition = await client.callTool({
      name: 'platform_tools_definition',
      arguments: { toolId: tool.id },
    });
    expect(JSON.stringify(definition)).toContain('public_echo');
    expect(JSON.stringify(definition)).not.toContain('delay');
    const before = upstream.count();
    await expect(
      client.callTool({
        name: 'platform_tools_call',
        arguments: { toolId: tool.id, arguments: { delay: 0 } },
      }),
    ).rejects.toThrow(/隐藏参数/);
    const result = await client.callTool({
      name: 'platform_tools_call',
      arguments: { toolId: tool.id, arguments: { message: 'semantic' } },
    });
    expect(JSON.stringify(result)).toContain('semantic');
    expect(upstream.count()).toBe(before + 1);
  } finally {
    await client.close();
  }
});
test('cached search does not reconnect stopped services, never indexes another account, and rechecks revocation after embedding', async () => {
  const { ownerId, profile, connection, tool, request } = await setup();
  const other = await setup();
  await h.services.connections.stop(ownerId, connection.id);
  const before = batches.length;
  expect(
    await h.services.discovery.search(ownerId, { profileId: profile.id, query: 'echo', limit: 10 }),
  ).toHaveLength(1);
  expect((await h.services.connections.owned(ownerId, connection.id)).status).toBe('stopped');
  const rows = await h.db
    .select()
    .from(toolVectors)
    .where(and(eq(toolVectors.ownerId, ownerId), eq(toolVectors.profileId, profile.id)));
  expect(rows.map((row) => row.toolId)).toEqual([tool.id]);
  expect(rows.some((row) => row.toolId === other.tool.id)).toBe(false);
  const footprint = await request(`/profiles/${profile.id}/context-footprint`);
  expect(footprint.status).toBe(200);
  expect(await footprint.json()).toMatchObject({
    encoding: 'o200k_base',
    estimated: true,
    billing: false,
    full: { tools: 1 },
    exposed: { tools: 3 },
  });
  expect(batches.length).toBe(before + 2);
  expect((await h.services.connections.owned(ownerId, connection.id)).status).toBe('stopped');
  duringQuery = async () => {
    await h.services.profiles.save(ownerId, { name: profile.name, toolIds: [] }, profile.id);
  };
  await expect(
    h.services.discovery.search(ownerId, { profileId: profile.id, query: 'revoke', limit: 10 }),
  ).rejects.toThrow(/检索期间/);
  duringQuery = undefined;
});
test('embedding outages expose explicit errors without keyword fallback, invalid response vectors are rejected', async () => {
  const { ownerId, profile } = await setup();
  httpStatus = 503;
  try {
    await expect(
      h.services.discovery.search(ownerId, { profileId: profile.id, query: 'echo', limit: 10 }),
    ).rejects.toMatchObject({ code: 'EMBEDDING_HTTP_ERROR' });
  } finally {
    httpStatus = 200;
  }
  const config = embeddingConfig.parse({ baseUrl, model: 'test' });
  for (const data of [
    { data: [{ index: 0, embedding: [0, 0] }] },
    { data: [{ index: 2, embedding: [1] }] },
    {},
  ]) {
    const client = new EmbeddingClient(async () => Response.json(data));
    await expect(client.embed({ config, texts: ['one'] })).rejects.toThrow();
  }
  expect(cosine(normalize([1, 2]), normalize([1, 2]))).toBeCloseTo(1);
});
