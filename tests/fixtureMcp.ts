import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
export async function fixtureMcp(
  options: {
    beforeList?: () => Promise<void>;
    instructions?: string;
    toolError?: boolean;
    onRequest?: (request: Request) => void;
    /** Listed after `echo`; calling one answers like echo. */
    extraTools?: Record<string, unknown>[];
  } = {},
) {
  const app = new Hono();
  const sessions = new Set<Server>();
  let count = 0;
  app.all('/mcp', async (c) => {
    options.onRequest?.(c.req.raw);
    const server = createFixtureMcpServer(() => count++, options);
    sessions.add(server);
    server.onclose = () => sessions.delete(server);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    return transport.handleRequest(c.req.raw);
  });
  const server = serve({ fetch: app.fetch, port: 0 });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No fixture address');
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    count: () => count,
    close: async () => {
      await Promise.all([...sessions].map((session) => session.close()));
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

export function createFixtureMcpServer(
  onCall: () => void,
  options: {
    beforeList?: () => Promise<void>;
    instructions?: string;
    toolError?: boolean;
    extraTools?: Record<string, unknown>[];
  } = {},
) {
  const server = new Server(
    { name: 'integration-fixture', version: '1' },
    { capabilities: { tools: {} }, instructions: options.instructions },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    await options.beforeList?.();
    return {
      tools: [
        {
          name: 'echo',
          description: 'Echo for SDK integration',
          inputSchema: {
            type: 'object',
            properties: { message: { type: 'string' }, delay: { type: 'number' } },
          },
        },
        ...((options.extraTools ?? []) as { name: string; inputSchema: { type: 'object' } }[]),
      ],
    };
  });
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    onCall();
    const delay = Number(request.params.arguments?.delay ?? 0);
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    return {
      ...(options.toolError ? { isError: true } : {}),
      content: [{ type: 'text', text: String(request.params.arguments?.message ?? 'echo') }],
      structuredContent: { name: 'echo' },
    };
  });
  return server;
}
