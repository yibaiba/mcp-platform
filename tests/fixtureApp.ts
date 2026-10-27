import { serve } from '@hono/node-server';
import { Server, createMcpHandler } from '@modelcontextprotocol/server';
export async function fixtureApp(
  html = '<!doctype html><p>App fixture</p>',
  options: { port?: number } = {},
) {
  let calls = 0;
  const uri = 'ui://example/main';
  const handler = createMcpHandler(() => {
    const server = new Server(
      { name: 'App fixture', version: '1' },
      { capabilities: { tools: {}, resources: {} } },
    );
    server.setRequestHandler('tools/list', async () => ({
      tools: [
        {
          name: 'show',
          inputSchema: { type: 'object' },
          _meta: { ui: { resourceUri: uri, visibility: ['model', 'app'] } },
        },
        {
          name: 'app_action',
          inputSchema: { type: 'object' },
          _meta: { ui: { visibility: ['app'] } },
        },
        {
          name: 'model_only',
          inputSchema: { type: 'object' },
          _meta: { ui: { visibility: ['model'] } },
        },
      ],
    }));
    server.setRequestHandler('tools/call', async (request) => {
      calls++;
      return {
        content: [{ type: 'text', text: request.params.name }],
        structuredContent: { count: calls },
      };
    });
    server.setRequestHandler('resources/list', async () => ({
      resources: [{ uri, name: 'App UI', mimeType: 'text/html;profile=mcp-app' }],
    }));
    server.setRequestHandler('resources/templates/list', async () => ({ resourceTemplates: [] }));
    server.setRequestHandler('resources/read', async () => ({
      contents: [
        {
          uri,
          mimeType: 'text/html;profile=mcp-app',
          text: html,
          _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] } } },
        },
      ],
    }));
    return server;
  });
  const server = serve({ port: options.port ?? 0, fetch: (r) => handler.fetch(r) });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No fixture address');
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    uri,
    calls: () => calls,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
