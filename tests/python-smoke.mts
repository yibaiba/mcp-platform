import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { bridge } from '@platform/pi-runtime';
import { parseCatalog, type OAuthClientProvider } from '../packages/mcp/src/index.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { connectionInput } from '../packages/contracts/src/index.js';
import { createDirectAdapter } from '../apps/server/src/modules/mcp/directAdapter.js';

const directory = await mkdtemp(join(tmpdir(), 'python-mcp-'));
const context = {
  id: randomUUID(),
  ownerId: 'python-acceptance',
  config: connectionInput.parse({
    name: 'Python SDK',
    connectTimeoutMs: Number(process.env.PYTHON_VERIFY_TIMEOUT_SECONDS ?? 60) * 1000,
    adapter: 'direct',
    transport: 'stdio',
    mode: 'managed',
    command: 'uvx',
    args: [
      '--from',
      'mcp==1.20.0',
      '--with',
      'pydantic==2.12.3',
      'python',
      resolve('tests/fixturePython.py'),
    ],
    env: { UV_OFFLINE: process.env.UV_OFFLINE ?? 'false' },
  }),
};
const noOAuth = new Proxy({} as OAuthClientProvider, {
  get() {
    throw new Error('stdio must not request OAuth');
  },
});
try {
  for (const kind of ['direct', 'pi'] as const) {
    const adapter =
      kind === 'direct'
        ? createDirectAdapter(context, noOAuth, { logStderr: console.error })
        : await bridge({ context, directory });
    try {
      const catalog = parseCatalog(await adapter.catalog());
      assert.ok(catalog.tools.some((tool) => tool.name === 'runtime_identity'));
      const result = CallToolResultSchema.parse(
        await adapter.call({ name: 'runtime_identity', arguments: { message: kind } }),
      );
      assert.ok(!result.isError);
      const text = result.content.find((block) => block.type === 'text');
      assert.ok(text?.type === 'text');
      assert.deepEqual(JSON.parse(text.text), { message: kind, python: '3.13.9', uid: 1000 });
      console.log(
        `PASS ${kind}: real Python SDK initialization, discovery and invocation; non-root`,
      );
    } finally {
      await adapter.close();
    }
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
