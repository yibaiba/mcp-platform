import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { serve } from '@hono/node-server';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { harness } from './harness.js';
import { fixtureConnector } from './fixtureConnector.js';

let h: Awaited<ReturnType<typeof harness>>;
let http: ReturnType<typeof serve>;
let url: string;
let dispatched = 0;
let interrupted = 0;
let device: Awaited<ReturnType<typeof fixtureConnector>>;
let deviceAccount: Awaited<ReturnType<typeof h.signup>>;
const sessions = new Map<
  string,
  { server: Server; transport: WebStandardStreamableHTTPServerTransport }
>();
beforeAll(async () => {
  h = await harness();
  deviceAccount = await h.signup();
  device = await fixtureConnector(h, deviceAccount.ownerId);
  http = serve({
    port: 0,
    fetch: async (request) => {
      const id = request.headers.get('mcp-session-id');
      if (id)
        return (
          sessions.get(id)?.transport.handleRequest(request) ??
          new Response('Unknown session', { status: 404 })
        );
      const server = new Server(
        { name: 'legacy-interaction', version: '1' },
        { capabilities: { tools: {} } },
      );
      server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [{ name: 'ask', inputSchema: { type: 'object' } }],
      }));
      server.setRequestHandler(CallToolRequestSchema, async (_request, context) => {
        dispatched++;
        context.signal.addEventListener('abort', () => interrupted++, { once: true });
        const answer = await server.elicitInput(
          {
            mode: 'form',
            message: 'User choice',
            requestedSchema: {
              type: 'object',
              properties: { answer: { type: 'string' } },
              required: ['answer'],
            },
          },
          { signal: context.signal },
        );
        return { content: [{ type: 'text', text: JSON.stringify(answer) }] };
      });
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: randomUUID,
        onsessioninitialized: (id) => {
          sessions.set(id, { server, transport });
        },
        onsessionclosed: (id) => {
          sessions.delete(id);
        },
      });
      await server.connect(transport);
      return transport.handleRequest(request);
    },
  });
  await new Promise<void>((resolve) => http.once('listening', resolve));
  const address = http.address();
  if (!address || typeof address === 'string') throw new Error('Missing address');
  url = `http://127.0.0.1:${address.port}/mcp`;
});
afterAll(async () => {
  await device?.close();
  await h?.close();
  await Promise.all([...sessions.values()].map((s) => s.server.close()));
  await new Promise<void>((resolve) => http.close(() => resolve()));
});
test.each(['direct', 'pi', 'device'] as const)(
  '%s legacy elicitation resumes the original dispatch without replay',
  async (adapter) => {
    const account = adapter === 'device' ? deviceAccount : await h.signup();
    const connection = await h.services.connections.create(account.ownerId, {
      name: `${adapter} legacy`,
      adapter,
      deviceId: adapter === 'device' ? device.deviceId : undefined,
      mode: 'existing',
      transport: 'http',
      url,
    });
    const tools = await h.services.connections.discover(account.ownerId, connection.id);
    const before = dispatched;
    const response = await account.request(`/tools/${tools[0]!.id}/call`, {
      method: 'POST',
      body: JSON.stringify({ arguments: {} }),
    });
    const pending = (await response.json()) as {
      resultType: string;
      interactionId: string;
      inputRequests: Record<string, unknown>;
    };
    expect(pending).toMatchObject({ resultType: 'input_required' });
    expect(dispatched - before).toBe(1);
    const question = Object.keys(pending.inputRequests)[0]!;
    const result = await account.request(`/interactions/${pending.interactionId}/respond`, {
      method: 'POST',
      body: JSON.stringify({ [question]: { action: 'accept', content: { answer: 'user' } } }),
    });
    expect(await result.json()).toMatchObject({
      content: [
        { type: 'text', text: JSON.stringify({ action: 'accept', content: { answer: 'user' } }) },
      ],
    });
    expect(dispatched - before).toBe(1);
    const cancelledBefore = interrupted;
    const waiting = await account.request(`/tools/${tools[0]!.id}/call`, {
      method: 'POST',
      body: JSON.stringify({ arguments: {} }),
    });
    const waitingCall = (await waiting.json()) as { callId: string };
    expect(
      (await account.request(`/calls/${waitingCall.callId}/cancel`, { method: 'POST' })).ok,
    ).toBe(true);
    await vi.waitFor(() => expect(interrupted - cancelledBefore).toBe(1));
    expect(dispatched - before).toBe(2);
  },
);
