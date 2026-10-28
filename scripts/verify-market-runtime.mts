import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  RegistryClient,
  OFFICIAL_REGISTRY,
} from '../apps/server/src/modules/market/registryClient.js';
import { compileRegistry } from '../apps/server/src/modules/market/compiler.js';
import { createDirectAdapter } from '../apps/server/src/modules/mcp/directAdapter.js';
import { marketSelection } from '../packages/contracts/src/index.js';
import type { OAuthClientProvider } from '../packages/mcp/src/index.js';

const registry = new RegistryClient({ fetch, baseUrl: OFFICIAL_REGISTRY });
const directory = await mkdtemp(join(tmpdir(), 'market-runtime-'));
const noOAuth = new Proxy({} as OAuthClientProvider, {
  get() {
    throw new Error('stdio cannot request OAuth');
  },
});
const selections = [
  {
    serverName: 'io.github.j0hanz/filesystem-mcp',
    version: '2.9.1',
    values: { 'args.0': [directory], 'args.--read-only': 'true' },
  },
  { serverName: 'io.github.Oncorporation/filesystem-server', version: '0.1.4', values: {} },
];
try {
  for (const selected of selections) {
    const input = marketSelection.parse({
      ...selected,
      name: 'Runtime acceptance',
      distribution: 'package',
      index: 0,
      adapter: 'direct',
    });
    const record = await registry.detail(input.serverName, input.version);
    const config = { ...compileRegistry(record.server, input), connectTimeoutMs: 120_000 };
    const adapter = createDirectAdapter(
      { id: randomUUID(), ownerId: 'market-runtime-acceptance', config },
      noOAuth,
      { logStderr: console.error },
    );
    try {
      const catalog = await adapter.catalog();
      assert.ok(catalog.tools.length > 0, 'Installed package must return its actual MCP tools');
      console.log(
        `PASS official Registry -> fixed ${config.registry!.identifier}@${config.registry!.packageVersion} -> ${config.command} argv -> real stdio discovery (${catalog.tools.length} tools)`,
      );
    } finally {
      await adapter.close();
    }
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
