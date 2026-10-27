import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { createFixtureMcpServer } from './fixtureMcp.js';

export async function fixtureSseMcp() {
  const sessions = new Map<string, SSEServerTransport>();
  let count = 0;
  async function handle(request: IncomingMessage, response: ServerResponse) {
    const url = new URL(request.url!, 'http://localhost');
    if (request.method === 'GET' && url.pathname === '/sse') {
      const transport = new SSEServerTransport('/messages', response);
      sessions.set(transport.sessionId, transport);
      response.once('close', () => sessions.delete(transport.sessionId));
      await createFixtureMcpServer(() => count++).connect(transport);
      return;
    }
    if (request.method === 'POST' && url.pathname === '/messages') {
      const transport = sessions.get(url.searchParams.get('sessionId') ?? '');
      if (!transport) {
        response.writeHead(404).end('Unknown session');
        return;
      }
      await transport.handlePostMessage(request, response);
      return;
    }
    response.writeHead(405).end('This fixture only supports legacy SSE');
  }
  const server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      console.error('SSE fixture failed', error);
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  server.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No SSE fixture address');
  return {
    url: `http://127.0.0.1:${address.port}/sse`,
    count: () => count,
    async close() {
      await Promise.all([...sessions.values()].map((transport) => transport.close()));
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
