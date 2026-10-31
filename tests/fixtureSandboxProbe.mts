// Stdio MCP server that reports what the process can see and do; used to verify the sandbox.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const attempt = (action: () => unknown) => {
  try {
    action();
    return true;
  } catch {
    return false;
  }
};
const server = new Server({ name: 'sandbox-probe', version: '1' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'probe',
      inputSchema: {
        type: 'object',
        properties: { secret: { type: 'string' }, outside: { type: 'string' } },
      },
    },
  ],
}));
server.setRequestHandler(CallToolRequestSchema, async (call) => {
  const { secret, outside } = (call.params.arguments ?? {}) as { secret: string; outside: string };
  const home = process.env.HOME ?? '';
  return {
    content: [{ type: 'text', text: 'probe' }],
    structuredContent: {
      home,
      cwd: process.cwd(),
      readSecret: attempt(() => readFileSync(secret)),
      writeOutside: attempt(() => writeFileSync(outside, 'x')),
      writeHome: attempt(() => writeFileSync(join(home, 'probe.txt'), 'x')),
      writeTmp: attempt(() => writeFileSync('/tmp/sandbox-probe.txt', 'x')),
      pid1: attempt(() => readFileSync('/proc/1/cmdline'))
        ? readFileSync('/proc/1/cmdline', 'utf8').split('\0')[0]
        : null,
    },
  };
});
await server.connect(new StdioServerTransport());
