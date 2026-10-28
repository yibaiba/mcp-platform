import { RestService } from '../apps/server/src/modules/rest/restService.js';
import { RestCallStore } from '../apps/server/src/modules/rest/callStore.js';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { serve } from '@hono/node-server';
import { Server, createMcpHandler } from '@modelcontextprotocol/server';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { restCalls } from '../packages/db/src/index.js';
import { harness } from './harness.js';
import { Vault } from '../apps/server/src/shared/crypto.js';
import { EncryptedResultStore } from '../apps/server/src/modules/rest/resultStore.js';
let h: Awaited<ReturnType<typeof harness>>;
let server: ReturnType<typeof serve>;
let url: string;
let started = 0;
let rounds = 0;
beforeAll(async () => {
  h = await harness();
  const handler = createMcpHandler(() => {
    const mcp = new Server({ name: 'rest-fixture', version: '1' }, { capabilities: { tools: {} } });
    mcp.setRequestHandler('tools/list', async () => ({
      tools: [
        {
          name: 'echo',
          description: 'Real REST invocation',
          inputSchema: {
            type: 'object',
            properties: {
              message: { type: 'string' },
              interaction: { type: 'boolean' },
              delay: { type: 'number' },
              hidden: { type: 'string' },
              payload: { $ref: '#/$defs/Payload' },
            },
            $defs: { Payload: { type: 'object', properties: { label: { type: 'string' } } } },
          },
        },
      ],
    }));
    mcp.setRequestHandler('tools/call', async (request, context) => {
      rounds++;
      const state = context.mcpReq.requestState();
      if (!state) started++;
      const args = request.params.arguments ?? {};
      if (args.delay) await new Promise((resolve) => setTimeout(resolve, Number(args.delay)));
      if (args.interaction && state !== 'url')
        return {
          resultType: 'input_required',
          requestState: state ? 'url' : 'form',
          inputRequests: {
            question: {
              method: 'elicitation/create',
              params: state
                ? {
                    mode: 'url',
                    message: 'Authorize',
                    url: 'https://example.test/authorize',
                    elicitationId: 'vendor-authorization',
                  }
                : {
                    mode: 'form',
                    message: 'Answer',
                    requestedSchema: {
                      type: 'object',
                      properties: { answer: { type: 'string' } },
                      required: ['answer'],
                    },
                  },
            },
          },
        };
      return {
        content: [{ type: 'text', text: String(args.message ?? 'done') }],
        structuredContent: { received: true },
      };
    });
    return mcp;
  });
  server = serve({ port: 0, fetch: (request) => handler.fetch(request) });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No server address');
  url = `http://127.0.0.1:${address.port}/mcp`;
});
afterAll(async () => {
  await h?.close();
  await new Promise<void>((resolve, reject) =>
    server?.close((error) => (error ? reject(error) : resolve())),
  );
});
async function setup() {
  const owner = await h.signup();
  const connection = await h.services.connections.create(owner.ownerId, {
    name: 'REST source',
    transport: 'http',
    mode: 'existing',
    adapter: 'direct',
    url,
  });
  const [tool] = await h.services.connections.discover(owner.ownerId, connection.id);
  const profile = (await h.services.profiles.save(owner.ownerId, {
    name: 'REST',
    toolIds: [tool!.id],
    catalog: { tools: { [tool!.id]: { alias: 'rest_echo', hiddenParameters: ['hidden'] } } },
  }))!;
  const key = await h.services.profiles.issue(owner.ownerId, profile.id);
  const request = (path: string, init: RequestInit = {}) =>
    fetch(`${h.baseURL}/mcp/${profile.id}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${key.token}`,
        'Content-Type': 'application/json',
        ...init.headers,
      },
    });
  const invoke = (args: unknown, idempotencyKey?: string) =>
    request(`/rest/tools/${tool!.id}`, {
      method: 'POST',
      body: JSON.stringify(args),
      headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {},
    });
  return { ...owner, connection, tool: tool!, profile, key, request, invoke };
}
test('OpenAPI 3.1 describes projected schemas; actual OpenAPI adapter calls the protected REST endpoint', async () => {
  const s = await setup();
  const response = await s.request('/openapi.json');
  expect(response.status).toBe(200);
  const document = await response.json();
  const path = `/mcp/${s.profile.id}/rest/tools/${s.tool.id}`;
  expect(document).toMatchObject({ openapi: '3.1.0', security: [{ bearerAuth: [] }] });
  expect(document.paths[path].post.operationId).toBe('rest_echo');
  expect(document.paths[path].post.requestBody.content['application/json'].schema).toEqual({
    $ref: `#/components/schemas/Input_${s.tool.id}`,
  });
  expect(document.components.schemas[`Input_${s.tool.id}`].properties).not.toHaveProperty('hidden');
  const api = await h.services.connections.create(s.ownerId, {
    name: 'Actual OpenAPI client',
    source: 'openapi',
    adapter: 'direct',
    transport: 'http',
    mode: 'existing',
    openapi: {
      document,
      baseUrl: h.baseURL,
      operations: [`POST ${path}`],
      credentials: { bearerAuth: { value: s.key.token } },
    },
  });
  const [operation] = await h.services.connections.discover(s.ownerId, api.id);
  const before = started;
  const result = await h.services.invocations.call({
    ownerId: s.ownerId,
    toolId: operation!.id,
    arguments: { body: { message: 'from-openapi' } },
  });
  expect(JSON.stringify(result)).toContain('from-openapi');
  expect(started).toBe(before + 1);
});
test('concurrent idempotent requests execute once; completed encrypted results survive new reader instances and identity binding', async () => {
  const s = await setup();
  const before = started;
  const result = await Promise.all([
    s.invoke({ message: 'private-result', delay: 80 }, 'same'),
    s.invoke({ delay: 80, message: 'private-result' }, 'same'),
  ]);
  expect(result.map((row) => row.status).sort()).toEqual([200, 202]);
  const id = result[0]!.headers.get('x-call-id')!;
  expect(result[1]!.headers.get('x-call-id')).toBe(id);
  expect(started).toBe(before + 1);
  const duplicate = await s.invoke({ delay: 80, message: 'private-result' }, 'same');
  expect(duplicate.status).toBe(200);
  expect(started).toBe(before + 1);
  expect((await s.invoke({ message: 'different' }, 'same')).status).toBe(409);
  const [row] = await h.db.select().from(restCalls).where(eq(restCalls.id, id));
  const encrypted = await readFile(join(h.directory, 'rest-results', `${id}.encrypted`), 'utf8');
  expect(encrypted).not.toContain('private-result');
  const store = new EncryptedResultStore(
    join(h.directory, 'rest-results'),
    new Vault(h.config.ENCRYPTION_KEY),
  );
  expect(JSON.stringify(await store.read(row!, row!.resultDigest!))).toContain('private-result');
  await expect(
    store.read({ ...row!, credentialId: 'another-credential' }, row!.resultDigest!),
  ).rejects.toMatchObject({ code: 'REST_RESULT_UNAVAILABLE' });
  const other = await h.services.profiles.issue(s.ownerId, s.profile.id);
  expect(
    (
      await s.request(`/rest/calls/${id}/result`, {
        headers: { Authorization: `Bearer ${other.token}` },
      })
    ).status,
  ).toBe(404);
  await h.services.profiles.revoke(s.ownerId, s.key.id);
  expect((await s.request(`/rest/calls/${id}/result`)).status).toBe(401);
});
test('form and URL rounds continue the original call, invalid/repeated answers are rejected, and hidden inputs never execute', async () => {
  const s = await setup();
  const before = started;
  expect((await s.invoke({ hidden: 'forbidden' })).status).toBe(400);
  expect(started).toBe(before);
  const initial = await s.invoke({ interaction: true }, 'interactive');
  expect(initial.status).toBe(202);
  const first = await initial.json();
  expect(first.status).toBe('waiting');
  expect(first.inputRequests.question.params.mode).toBe('form');
  const answer = (interactionId: string, responses: unknown) =>
    s.request(`/rest/calls/${first.callId}/answer`, {
      method: 'POST',
      body: JSON.stringify({ interactionId, responses }),
    });
  expect(
    (await answer(first.interactionId, { question: { action: 'accept', content: {} } })).status,
  ).toBe(400);
  const next = await answer(first.interactionId, {
    question: { action: 'accept', content: { answer: 'yes' } },
  });
  expect(next.status).toBe(202);
  const second = await next.json();
  expect(second.callId).toBe(first.callId);
  expect(second.interactionId).not.toBe(first.interactionId);
  expect(second.inputRequests.question.params.mode).toBe('url');
  expect((await answer(first.interactionId, { question: { action: 'decline' } })).status).toBe(409);
  const finished = await answer(second.interactionId, { question: { action: 'accept' } });
  expect(finished.status).toBe(200);
  expect(started).toBe(before + 1);
  expect(rounds).toBeGreaterThan(started);
  expect((await answer(second.interactionId, { question: { action: 'accept' } })).status).toBe(409);
});
test('cancel and restart mark unfinished calls unknown without replay; completed results remain readable', async () => {
  const s = await setup();
  const complete = await s.invoke({ message: 'completed-before-recovery' }, 'completed');
  const completeId = complete.headers.get('x-call-id')!;
  const waiting = await (await s.invoke({ interaction: true }, 'pending')).json();
  const before = started;
  expect((await s.request(`/rest/calls/${waiting.callId}/cancel`, { method: 'POST' })).status).toBe(
    200,
  );
  expect(
    (
      await s.request(`/rest/calls/${waiting.callId}/answer`, {
        method: 'POST',
        body: JSON.stringify({
          interactionId: waiting.interactionId,
          responses: { question: { action: 'decline' } },
        }),
      })
    ).status,
  ).toBe(409);
  const pending = await (await s.invoke({ interaction: true }, 'restart')).json();
  await h.services.connections.close(s.ownerId, s.connection.id);
  await h.services.rest.recover();
  await h.services.interactions.recover();
  expect((await (await s.request(`/rest/calls/${pending.callId}`)).json()).status).toBe('unknown');
  expect((await s.request(`/rest/calls/${completeId}/result`)).status).toBe(200);
  expect((await s.invoke({ interaction: true }, 'restart')).status).toBe(409);
  expect(started).toBe(before + 1);
});

test('failed result persistence is reported and an idempotent retry never repeats the upstream side effect', async () => {
  const s = await setup();
  const principal = await h.services.profiles.authenticate(s.profile.id, s.key.token);
  const failing = new RestService({
    profiles: h.services.profiles,
    invocations: h.services.invocations,
    interactions: h.services.interactions,
    logger: h.services.logger,
    store: new RestCallStore(h.db, new Vault(h.config.ENCRYPTION_KEY)),
    results: {
      save: async () => {
        throw new Error('Disk write failure');
      },
      read: async () => {
        throw new Error('Result must not exist');
      },
    },
  });
  const before = started;
  const input = {
    toolId: s.tool.id,
    arguments: { message: 'completed-but-unsaved' },
    idempotencyKey: 'save-failure',
  };
  await expect(
    failing.context(principal, () => failing.start(principal, input)),
  ).rejects.toMatchObject({ code: 'REST_RESULT_SAVE_FAILED' });
  const retry = await failing.context(principal, () => failing.start(principal, input));
  expect(retry).toMatchObject({
    status: 500,
    body: { status: 'result_error', errorCode: 'REST_RESULT_SAVE_FAILED' },
  });
  expect(started).toBe(before + 1);
  await failing.close();
});
