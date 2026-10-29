import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { normalize } from '../apps/server/src/modules/discovery/embeddingClient.js';
export const TOOL_COUNT = 10_000,
  DIMENSIONS = 1536,
  QUERY_COUNT = 30;
export function searchCorpus() {
  let seed = 20261029;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 2 ** 32 - 0.5;
  };
  const centers = Array.from({ length: 64 }, () => Array.from({ length: DIMENSIONS }, random));
  const vectors = Array.from({ length: TOOL_COUNT }, (_, i) =>
    normalize(centers[i % centers.length]!.map((v) => v + random() * 0.25)),
  );
  const queries = Array.from({ length: QUERY_COUNT }, (_, i) =>
    normalize(vectors[i * 313]!.map((v) => v + random() * 0.001)),
  );
  return { vectors, queries };
}
export async function benchmarkFixture(corpus: ReturnType<typeof searchCorpus>) {
  const app = new Hono(),
    sessions = new Set<Server>();
  let businessCalls = 0;
  app.post('/v1/embeddings', async (c) => {
    const body = await c.req.json<{ input: string[] }>();
    return c.json({
      data: body.input.map((text, index) => ({
        index,
        embedding: text.startsWith('query:')
          ? corpus.queries[Number(text.slice(6))]
          : corpus.vectors[Number(JSON.parse(text).name.slice(6))],
      })),
    });
  });
  app.all('/mcp', async (c) => {
    const server = new Server(
      { name: 'benchmark-catalog', version: '1' },
      { capabilities: { tools: {} } },
    );
    sessions.add(server);
    server.onclose = () => sessions.delete(server);
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: corpus.vectors.map((_, index) => ({
        name: `bench_${index}`,
        description: `Synthetic benchmark tool ${index}`,
        inputSchema: { type: 'object' as const },
      })),
    }));
    server.setRequestHandler(CallToolRequestSchema, async () => {
      businessCalls++;
      throw new Error('Benchmark must not execute business tools');
    });
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    return transport.handleRequest(c.req.raw);
  });
  const server = serve({ port: 0, fetch: app.fetch });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture address');
  return {
    url: `http://127.0.0.1:${address.port}`,
    businessCalls: () => businessCalls,
    async close() {
      await Promise.all([...sessions].map((session) => session.close()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
