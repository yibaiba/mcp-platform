import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixtureMcp } from './fixtureMcp.js';
const modulePath = '@platform/pi-runtime';
const { bridge } = await import(modulePath);
const fixture = await fixtureMcp();
const directory = await mkdtemp(join(tmpdir(), 'pi-platform-test-'));
const adapter = await bridge({
  context: { id: randomUUID(), ownerId: 'integration', config: { url: fixture.url, headers: {} } },
  directory,
});
try {
  const tools = await adapter.discover();
  if (!Array.isArray(tools) || tools[0]?.name !== 'echo') throw new Error('Pi catalog mismatch');
  const result = await adapter.call({ name: 'echo', arguments: { message: 'pi without a model' } });
  if (result.content[0]?.text !== 'pi without a model' || result.structuredContent?.name !== 'echo')
    throw new Error('Pi result mismatch');
  console.log(
    'PASS: actual Pi SDK + pi-mcp-adapter discovery/call, no model, original structuredContent preserved',
  );
} finally {
  await adapter.close();
  await fixture.close();
  await rm(directory, { recursive: true, force: true });
}
