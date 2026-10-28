import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { appendFile } from 'node:fs/promises';
const effects = process.argv[2];
if (!effects) throw new Error('Expected disposable side-effect log path');
const server = new Server(
  { name: 'rest-restart-fixture', version: '1' },
  { capabilities: { tools: {} } },
);
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'restart_echo',
      inputSchema: {
        type: 'object',
        required: ['marker'],
        properties: {
          marker: { type: 'string' },
          wait: { type: 'boolean' },
          delay: { type: 'number' },
        },
      },
    },
  ],
}));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const args = request.params.arguments ?? {};
  await appendFile(effects, `${String(args.marker)}\n`, { mode: 0o600 });
  if (args.wait)
    await server.elicitInput({
      message: 'Wait across process termination',
      requestedSchema: {
        type: 'object',
        properties: { answer: { type: 'string' } },
        required: ['answer'],
      },
    });
  if (args.delay) await new Promise((resolve) => setTimeout(resolve, Number(args.delay)));
  return { content: [{ type: 'text', text: String(args.marker) }] };
});
await server.connect(new StdioServerTransport());
