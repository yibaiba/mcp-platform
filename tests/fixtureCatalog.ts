import { serve } from '@hono/node-server';
import { randomUUID } from 'node:crypto';
import {
  createMcpHandler,
  isLegacyRequest,
  Server,
  WebStandardStreamableHTTPServerTransport,
  type Tool,
} from '@modelcontextprotocol/server';

export async function fixtureCatalog() {
  const sessions = new Map<
    string,
    { server: Server; transport: WebStandardStreamableHTTPServerTransport }
  >();
  let toolCount = 0;
  let promptName = 'review';
  let text = 'resource body';
  let invalidOutput = false;
  let nextToolResult: Promise<void> | undefined;
  let schema: Tool['inputSchema'] = {
    type: 'object',
    $schema: 'http://json-schema.org/draft-07/schema#',
    properties: { message: { type: 'string' } },
  };
  function create() {
    const server = new Server(
      { name: 'catalog-fixture', version: '1' },
      {
        capabilities: {
          tools: { listChanged: true },
          prompts: { listChanged: true },
          resources: { listChanged: true, subscribe: true },
        },
      },
    );
    server.setRequestHandler('tools/list', async () => ({
      tools: [
        {
          name: 'echo',
          title: 'Echo title',
          inputSchema: schema,
          outputSchema: {
            type: 'object',
            $schema: 'https://json-schema.org/draft/2020-12/schema',
            properties: { message: { type: 'string' } },
            required: ['message'],
          },
          annotations: { readOnlyHint: true },
          _meta: { fixture: 'preserved' },
        },
      ],
    }));
    server.setRequestHandler('tools/call', async (request, context) => {
      toolCount++;
      const resultReady = nextToolResult;
      nextToolResult = undefined;
      const token = request.params._meta?.progressToken;
      if (token !== undefined)
        await context.mcpReq.notify({
          method: 'notifications/progress',
          params: { progressToken: token, progress: 1, total: 1, message: 'done' },
        });
      await resultReady;
      const message = String(request.params.arguments?.message ?? 'echo');
      return {
        content: [{ type: 'text', text: message }],
        structuredContent: { message: invalidOutput ? 42 : message },
        _meta: { fixture: 'raw result' },
      };
    });
    server.setRequestHandler('prompts/list', async (request) =>
      request.params?.cursor
        ? { prompts: [{ name: 'second', description: 'second page' }] }
        : {
            prompts: [{ name: promptName, arguments: [{ name: 'subject', required: true }] }],
            nextCursor: 'page-2',
          },
    );
    server.setRequestHandler('prompts/get', async (request) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `${request.params.name}:${request.params.arguments?.subject ?? ''}`,
          },
        },
        {
          role: 'user',
          content: { type: 'resource', resource: { uri: 'file:///shared.txt', text } },
        },
      ],
      _meta: { fixture: 'prompt' },
    }));
    server.setRequestHandler('resources/list', async (request) =>
      request.params?.cursor
        ? { resources: [{ name: 'other', uri: 'file:///other.txt' }] }
        : {
            resources: [{ name: 'shared', uri: 'file:///shared.txt', mimeType: 'text/plain' }],
            nextCursor: 'page-2',
          },
    );
    server.setRequestHandler('resources/templates/list', async () => ({
      resourceTemplates: [{ name: 'notes', uriTemplate: 'note:///{key}' }],
    }));
    server.setRequestHandler('resources/read', async (request) => ({
      contents: [{ uri: request.params.uri, text: `${text}:${request.params.uri}` }],
      _meta: { fixture: 'resource' },
    }));
    server.setRequestHandler('resources/subscribe', async () => ({}));
    server.setRequestHandler('resources/unsubscribe', async () => ({}));
    return server;
  }
  const modern = createMcpHandler(create, { legacy: 'reject' });
  const http = serve({
    port: 0,
    fetch: async (request) => {
      if (!(await isLegacyRequest(request))) return modern.fetch(request);
      const id = request.headers.get('mcp-session-id');
      if (id) {
        const session = sessions.get(id);
        return session
          ? session.transport.handleRequest(request)
          : new Response('Unknown session', { status: 404 });
      }
      const server = create();
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
  if (!address || typeof address === 'string') throw new Error('No fixture address');
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    calls: () => toolCount,
    holdNextToolResult() {
      if (nextToolResult) throw new Error('A tool result is already held');
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      nextToolResult = held;
      return () => {
        if (nextToolResult === held) nextToolResult = undefined;
        release();
      };
    },
    schema: (value: Tool['inputSchema']) => {
      schema = value;
    },
    invalidOutput: (value: boolean) => {
      invalidOutput = value;
    },
    async changed(kind: 'tools' | 'prompts' | 'resources') {
      for (const session of sessions.values())
        await session.server.notification({ method: `notifications/${kind}/list_changed` });
      if (kind === 'tools') modern.notify.toolsChanged();
      if (kind === 'prompts') modern.notify.promptsChanged();
      if (kind === 'resources') modern.notify.resourcesChanged();
    },
    promptName: (name: string) => {
      promptName = name;
    },
    async update(value: string, uri = 'file:///shared.txt') {
      text = value;
      for (const session of sessions.values()) await session.server.sendResourceUpdated({ uri });
      modern.notify.resourceUpdated(uri);
    },
    async close() {
      await modern.close();
      await Promise.all([...sessions.values()].map((session) => session.server.close()));
      await new Promise<void>((resolve, reject) =>
        http.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
