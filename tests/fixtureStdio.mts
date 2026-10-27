import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
const server = new Server(
  { name: 'stdio-integration', version: '1' },
  { capabilities: { tools: {} } },
);
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    { name: 'echo', inputSchema: { type: 'object', properties: { message: { type: 'string' } } } },
  ],
}));
server.setRequestHandler(CallToolRequestSchema, async (call) => ({
  content: [{ type: 'text', text: String(call.params.arguments?.message) }],
  structuredContent: {
    pid: process.pid,
    cwd: process.cwd(),
    marker: process.env.MCP_TEST_MARKER ?? null,
  },
}));
await server.connect(new StdioServerTransport());
