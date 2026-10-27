import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { serve } from '@hono/node-server';
import { Server, createMcpHandler } from '@modelcontextprotocol/server';
import {
  Client,
  StreamableHTTPClientTransport,
  isInputRequiredResult,
} from '@modelcontextprotocol/client';
import { Client as LegacyClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport as LegacyTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { harness } from './harness.js';
import { withExecution } from '../apps/server/src/modules/mcp/executionContext.js';
import { temporaryGrants } from '../packages/db/src/index.js';
import { eq } from 'drizzle-orm';
let h: Awaited<ReturnType<typeof harness>>;
let upstream: ReturnType<typeof serve>;
let url: string;
let dispatched = 0;
test('revoking temporary tool permission ends interaction without dispatching its continuation', async () => {
  const s = await setup();
  await s.account.request(`/calls/${s.pending.callId}/cancel`, { method: 'POST' });
  const tool = (await h.services.profiles.catalog(s.account.ownerId)).find(
    (row) => row.connectionId === s.connection.id,
  )!;
  const profile = (await h.services.profiles.save(s.account.ownerId, {
    name: 'temporary interaction',
    requestable: { toolIds: [tool.id], contentIds: [], artifactIds: [] },
  }))!;
  const key = await h.services.profiles.issue(s.account.ownerId, profile.id);
  const principal = await h.services.profiles.authenticate(profile.id, key.token);
  await withExecution(
    {
      ownerId: s.account.ownerId,
      profileId: profile.id,
      identity: key.id,
      credentialId: key.id,
      entry: 'gateway',
      sessionId: 'temporary',
      capabilities: { elicitation: { form: {} } },
    },
    async () => {
      const access = { ownerId: s.account.ownerId, profileId: profile.id };
      const request = await h.services.requests.create(access, {
        permissions: { toolIds: [tool.id], contentIds: [], artifactIds: [] },
        reason: 'interactive permission',
        idempotencyKey: 'interactive',
      });
      await h.services.requests.decide(s.account.ownerId, request.id, {
        decision: 'approved',
        permissions: request.requested,
      });
      const before = dispatched;
      const result = await h.services.invocations.dispatch({
        ...access,
        principal,
        toolId: tool.id,
        arguments: {},
      });
      expect(dispatched - before).toBe(1);
      const [grant] = await h.db
        .select()
        .from(temporaryGrants)
        .where(eq(temporaryGrants.requestId, request.id));
      await h.services.requests.revoke(s.account.ownerId, grant!.id);
      await expect(
        h.services.interactions.respond({
          ownerId: s.account.ownerId,
          id: String(result.interactionId),
          credentialId: key.id,
          toolId: tool.id,
          responses: { question: { action: 'decline' } },
        }),
      ).rejects.toThrow('交互已结束');
      expect(dispatched - before).toBe(1);
    },
  );
});
beforeAll(async () => {
  h = await harness();
  const handler = createMcpHandler(() => {
    const server = new Server(
      { name: 'interactive-test', version: '1' },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler('tools/list', async () => ({
      tools: [
        {
          name: 'interactive',
          inputSchema: { type: 'object' },
          outputSchema: {
            type: 'object',
            required: ['answer'],
            properties: { answer: { type: 'string' } },
          },
        },
      ],
    }));
    server.setRequestHandler('tools/call', async (_request, context) => {
      dispatched++;
      const responses = context.mcpReq.inputResponses;
      if (!responses)
        return {
          resultType: 'input_required',
          inputRequests: {
            question: {
              method: 'elicitation/create',
              params: {
                mode: 'form',
                message: 'Choose an answer',
                requestedSchema: {
                  type: 'object',
                  properties: { answer: { type: 'string' } },
                  required: ['answer'],
                },
              },
            },
          },
          requestState: 'upstream-state',
        };
      expect(context.mcpReq.requestState()).toBe('upstream-state');
      const response = responses.question as { action: string; content?: { answer?: string } };
      return {
        content: [{ type: 'text', text: response.content?.answer ?? response.action }],
        structuredContent: { answer: response.content?.answer ?? response.action },
      };
    });
    return server;
  });
  upstream = serve({ port: 0, fetch: (request) => handler.fetch(request) });
  await new Promise<void>((resolve) => upstream.once('listening', resolve));
  const address = upstream.address();
  if (!address || typeof address === 'string') throw new Error('Missing address');
  url = `http://127.0.0.1:${address.port}/mcp`;
});
afterAll(async () => {
  await h?.close();
  await new Promise<void>((resolve) => upstream?.close(() => resolve()));
});
async function setup(interactionDeadline?: string) {
  const account = await h.signup();
  const connection = await h.services.connections.create(account.ownerId, {
    name: 'Interactive',
    adapter: 'direct',
    transport: 'http',
    mode: 'existing',
    url,
  });
  const tools = await h.services.connections.discover(account.ownerId, connection.id);
  const response = await account.request(`/tools/${tools[0]!.id}/call`, {
    method: 'POST',
    body: JSON.stringify({ arguments: {}, interactionDeadline }),
  });
  expect(response.status).toBe(200);
  const pending = (await response.json()) as {
    interactionId: string;
    callId: string;
    resultType: string;
  };
  expect(pending).toMatchObject({ resultType: 'input_required' });
  return { account, connection, pending };
}
test('modern input_required is preserved and only a valid explicit response dispatches the next round', async () => {
  const before = dispatched;
  const { account, connection, pending } = await setup();
  expect(dispatched - before).toBe(1);
  const busy = await account.request(`/connections/${connection.id}/sleep`, { method: 'POST' });
  expect(busy.status).toBe(409);
  const invalid = await account.request(`/interactions/${pending.interactionId}/respond`, {
    method: 'POST',
    body: JSON.stringify({ question: { action: 'accept', content: {} } }),
  });
  expect(invalid.status).toBe(400);
  expect(dispatched - before).toBe(1);
  const accepted = await account.request(`/interactions/${pending.interactionId}/respond`, {
    method: 'POST',
    body: JSON.stringify({ question: { action: 'accept', content: { answer: 'real user' } } }),
  });
  expect(await accepted.json()).toMatchObject({ structuredContent: { answer: 'real user' } });
  expect(dispatched - before).toBe(2);
  const duplicate = await account.request(`/interactions/${pending.interactionId}/respond`, {
    method: 'POST',
    body: JSON.stringify({ question: { action: 'cancel' } }),
  });
  expect(duplicate.status).toBe(409);
  expect(dispatched - before).toBe(2);
});
test('stopping a runtime interrupts pending interaction and cannot restart it on response', async () => {
  const before = dispatched;
  const { account, connection, pending } = await setup();
  await h.services.connections.stop(account.ownerId, connection.id);
  const response = await account.request(`/interactions/${pending.interactionId}/respond`, {
    method: 'POST',
    body: JSON.stringify({ question: { action: 'decline' } }),
  });
  expect(response.status).toBe(409);
  expect(dispatched - before).toBe(1);
});
test('an explicit interaction deadline interrupts waiting without dispatching a continuation', async () => {
  const before = dispatched;
  const { account, pending } = await setup(new Date(Date.now() + 1000).toISOString());
  await vi.waitFor(
    async () => {
      const rows = (await (await account.request('/interactions')).json()) as { id: string }[];
      expect(rows.some((row) => row.id === pending.interactionId)).toBe(false);
    },
    { timeout: 2500 },
  );
  const response = await account.request(`/interactions/${pending.interactionId}/respond`, {
    method: 'POST',
    body: JSON.stringify({ question: { action: 'cancel' } }),
  });
  expect(response.status).toBe(409);
  expect(dispatched - before).toBe(1);
});
test.each(['modern', 'legacy'] as const)(
  '%s external official client explicitly responds to a modern upstream interaction',
  async (era) => {
    const { account, connection, pending } = await setup();
    await account.request(`/calls/${pending.callId}/cancel`, { method: 'POST' });
    const tools = await h.services.profiles.catalog(account.ownerId);
    const tool = tools.find((t) => t.connectionId === connection.id)!;
    const profile = (await h.services.profiles.save(account.ownerId, {
      name: 'External interaction',
      toolIds: [tool.id],
    }))!;
    const key = await h.services.profiles.issue(account.ownerId, profile.id);
    const endpoint = new URL(`${h.baseURL}/mcp/${profile.id}`);
    const requestInit = { headers: { Authorization: `Bearer ${key.token}` } };
    const before = dispatched;
    if (era === 'legacy') {
      const client = new LegacyClient(
        { name: 'Legacy interaction', version: '1' },
        { capabilities: { elicitation: { form: {} } } },
      );
      client.setRequestHandler(ElicitRequestSchema, async () => ({ action: 'decline' }));
      await client.connect(new LegacyTransport(endpoint, { requestInit }));
      try {
        expect(await client.callTool({ name: tool.id, arguments: {} })).toMatchObject({
          structuredContent: { answer: 'decline' },
        });
      } finally {
        await client.close();
      }
    } else {
      const client = new Client(
        { name: 'Modern interaction', version: '1' },
        {
          capabilities: { elicitation: { form: {} } },
          versionNegotiation: { mode: 'auto' },
          inputRequired: { autoFulfill: false },
        },
      );
      await client.connect(new StreamableHTTPClientTransport(endpoint, { requestInit }));
      try {
        await client.listTools();
        const first = await client.request(
          { method: 'tools/call', params: { name: tool.id, arguments: {} } },
          { allowInputRequired: true },
        );
        expect(isInputRequiredResult(first)).toBe(true);
        if (!isInputRequiredResult(first)) throw new Error('Expected interaction');
        expect(
          await client.request(
            {
              method: 'tools/call',
              params: {
                name: tool.id,
                arguments: {},
                requestState: first.requestState,
                inputResponses: {
                  question: { action: 'accept', content: { answer: 'external user' } },
                },
              },
            },
            { allowInputRequired: true },
          ),
        ).toMatchObject({ structuredContent: { answer: 'external user' } });
      } finally {
        await client.close();
      }
    }
    expect(dispatched - before).toBe(2);
  },
);
