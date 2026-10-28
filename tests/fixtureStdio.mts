import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
const server = new Server(
  { name: 'stdio-integration', version: '1' },
  { capabilities: { tools: {} } },
);
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'echo',
      inputSchema: {
        type: 'object',
        properties: {
          message: { type: 'string' },
          delay: { type: 'number' },
          progress: { type: 'number' },
        },
      },
    },
  ],
}));
server.setRequestHandler(CallToolRequestSchema, async (call, extra) => {
  const delay = Number(call.params.arguments?.delay ?? 0);
  const interval = Number(call.params.arguments?.progress ?? 0);
  let progress = 0;
  const timer = interval
    ? setInterval(() => {
        if (call.params._meta?.progressToken === undefined) return;
        void extra
          .sendNotification({
            method: 'notifications/progress',
            params: { progressToken: call.params._meta.progressToken, progress: ++progress },
          })
          .catch((error: unknown) => console.error(error));
      }, interval)
    : undefined;
  try {
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    return {
      content: [{ type: 'text', text: String(call.params.arguments?.message) }],
      structuredContent: {
        pid: process.pid,
        cwd: process.cwd(),
        marker: process.env.MCP_TEST_MARKER ?? null,
      },
    };
  } finally {
    clearInterval(timer);
  }
});
await server.connect(new StdioServerTransport());
