import { afterAll, beforeAll, expect, test } from 'vitest';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { harness } from './harness.js';
let h: Awaited<ReturnType<typeof harness>>;
let server: ReturnType<typeof serve>;
let baseUrl: string;
let count = 0;
let last: unknown;
const document = {
  openapi: '3.1.0',
  info: { title: 'Real HTTP API', version: '1', description: 'Service instructions' },
  components: {
    securitySchemes: {
      key: { type: 'apiKey', name: 'X-API-Key', in: 'header' },
      bearer: { type: 'http', scheme: 'bearer' },
    },
  },
  paths: {
    '/items/{id}': {
      get: {
        security: [{ key: [], bearer: [] }, {}],
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          {
            name: 'tag',
            in: 'query',
            schema: { type: 'array', items: { type: 'string' } },
            explode: true,
          },
          { name: 'X-Trace', in: 'header', schema: { type: 'string' } },
          { name: 'session', in: 'cookie', schema: { type: 'string' } },
        ],
        responses: { '200': { description: 'Items' } },
      },
    },
    '/upload': {
      post: {
        requestBody: {
          required: true,
          content: {
            'multipart/form-data': {
              schema: {
                type: 'object',
                properties: { file: { type: 'string', format: 'binary' } },
                required: ['file'],
              },
            },
          },
        },
        responses: { '200': { description: 'File' } },
      },
    },
    '/unsupported': {
      post: {
        requestBody: { content: { 'application/xml': { schema: { type: 'object' } } } },
        responses: { '200': { description: 'Unsupported XML' } },
      },
    },
    '/error': { get: { responses: { '500': { description: 'Failure' } } } },
  },
};
beforeAll(async () => {
  h = await harness();
  const app = new Hono();
  app.get('/openapi.json', (c) => c.json(document));
  app.get('/items/:id', (c) => {
    count++;
    last = {
      path: c.req.param('id'),
      query: c.req.queries('tag'),
      key: c.req.header('X-API-Key'),
      bearer: c.req.header('Authorization'),
      cookie: c.req.header('Cookie'),
      trace: c.req.header('X-Trace'),
    };
    return c.json(last);
  });
  app.post('/upload', async (c) => {
    count++;
    const form = await c.req.formData();
    const file = form.get('file');
    if (!(file instanceof File)) return c.text('Expected file', 400);
    last = await file.text();
    return new Response(file.stream(), { headers: { 'Content-Type': 'application/octet-stream' } });
  });
  app.get('/error', (c) => {
    count++;
    return c.text('Failed', 500);
  });
  server = serve({ fetch: app.fetch, port: 0 });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing address');
  baseUrl = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
  await h?.close();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
});
async function setup(operations: string[], securityChoices: Record<string, number> = {}) {
  const account = await h.signup();
  const connection = await h.services.connections.create(account.ownerId, {
    name: 'OpenAPI',
    source: 'openapi',
    adapter: 'direct',
    transport: 'http',
    mode: 'existing',
    openapi: {
      document,
      baseUrl,
      operations,
      securityChoices,
      credentials: { key: { value: 'upstream-key' }, bearer: { value: 'upstream-token' } },
    },
  });
  const tools = await h.services.connections.discover(account.ownerId, connection.id);
  return { account, connection, tools };
}
test('OpenAPI import previews operations, credentials and unsupported content before publishing', async () => {
  const account = await h.signup();
  const response = await account.request('/openapi/preview', {
    method: 'POST',
    body: JSON.stringify({ url: `${baseUrl}/openapi.json` }),
  });
  expect(response.status).toBe(200);
  const preview = (await response.json()) as {
    operations: { key: string; unsupported: string[] }[];
  };
  expect(preview.operations).toHaveLength(4);
  expect(preview.operations.find((op) => op.key === 'POST /unsupported')?.unsupported).toEqual([
    '不支持请求内容类型 application/xml',
  ]);
});
test('API execution honors path/query/header/cookie and explicit OR selection with AND credentials', async () => {
  const { account, tools } = await setup(['GET /items/{id}'], { 'GET /items/{id}': 0 });
  const before = count;
  const result = await h.services.invocations.call({
    ownerId: account.ownerId,
    toolId: tools[0]!.id,
    arguments: {
      path: { id: 'a/b' },
      query: { tag: ['a', 'b'] },
      header: { 'X-Trace': 'trace' },
      cookie: { session: 'cookie-value' },
    },
  });
  expect(result.structuredContent).toMatchObject({
    response: {
      path: 'a/b',
      query: ['a', 'b'],
      key: 'upstream-key',
      bearer: 'Bearer upstream-token',
      cookie: 'session=cookie-value',
      trace: 'trace',
    },
  });
  expect(count - before).toBe(1);
  const ambiguous = await setup(['GET /items/{id}']);
  await expect(
    h.services.invocations.call({
      ownerId: ambiguous.account.ownerId,
      toolId: ambiguous.tools[0]!.id,
      arguments: { path: { id: 'ambiguous' } },
    }),
  ).rejects.toThrow(/明确选择/);
  expect(count - before).toBe(1);
});
test('multipart uses an authorized artifact and binary response streams into a new artifact without replay', async () => {
  const { account, tools } = await setup(['POST /upload', 'GET /error']);
  const artifact = await h.services.artifacts.store(account.ownerId, {
    name: 'source.txt',
    body: new Blob(['real-file-bytes']).stream(),
  });
  const result = await h.services.invocations.call({
    ownerId: account.ownerId,
    toolId: tools.find((t) => t.name === 'POST /upload')!.id,
    arguments: { body: { file: artifact.id } },
  });
  expect(last).toBe('real-file-bytes');
  const id = String(result.structuredContent?.artifactId);
  expect(await (await h.services.artifacts.download(account.ownerId, id)).text()).toBe(
    'real-file-bytes',
  );
  const before = count;
  await expect(
    h.services.invocations.call({
      ownerId: account.ownerId,
      toolId: tools.find((t) => t.name === 'GET /error')!.id,
      arguments: {},
    }),
  ).rejects.toThrow(/HTTP 500/);
  expect(count - before).toBe(1);
});
