import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { config } from 'dotenv';
import { createDatabase, user, profiles } from '../packages/db/src/index.js';
import { VectorStore } from '../apps/server/src/modules/discovery/vectorStore.js';
import { cosine, normalize } from '../apps/server/src/modules/discovery/embeddingClient.js';
config({ path: '.env', quiet: true });
if (!process.env.DATABASE_URL)
  throw new Error('A migrated test PostgreSQL DATABASE_URL is required');
const { db, pool } = createDatabase(process.env.DATABASE_URL);
const ownerId = randomUUID();
const profileId = randomUUID();
const dimensions = 1536;
const query = normalize(Array.from({ length: dimensions }, (_, j) => Math.sin(j + 1)));
const store = new VectorStore(db);
try {
  await db
    .insert(user)
    .values({
      id: ownerId,
      name: 'Discovery benchmark fixture',
      email: `${ownerId}@example.test`,
      emailVerified: false,
    });
  await db.insert(profiles).values({ id: profileId, ownerId, name: 'Benchmark' });
  for (const count of [1000, 10000]) {
    const scope = { ownerId, profileId, scope: `benchmark-${count}` };
    const ids = Array.from({ length: count }, (_, i) => `benchmark-tool-${i}`);
    const prepared = performance.now();
    for (let offset = 0; offset < count; offset += 100) {
      await store.save(
        scope,
        ids.slice(offset, offset + 100).map((toolId, index) => ({
          toolId,
          definitionHash: 'synthetic-benchmark-only',
          vector: normalize(
            Array.from({ length: dimensions }, (_, j) => Math.sin((offset + index + 1) * (j + 1))),
          ),
        })),
      );
    }
    const indexWriteMs = performance.now() - prepared;
    const samples = [];
    for (let i = 0; i < 3; i++) {
      const started = performance.now();
      const rows = await store.read(scope, ids);
      const readMs = performance.now() - started;
      assert.equal(rows.length, count);
      const top = rows
        .map((row) => ({ id: row.toolId, score: cosine(query, row.vector) }))
        .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
        .slice(0, 10);
      assert.equal(top[0]!.id, ids[0]);
      samples.push({ databaseReadMs: readMs, totalMs: performance.now() - started });
    }
    assert.deepEqual(await store.read({ ...scope, ownerId: randomUUID() }, ids), []);
    console.log(
      JSON.stringify({
        kind: 'postgres-authorized-candidates-exact-cosine',
        tools: count,
        dimensions,
        indexWriteMs,
        samples,
        medianMs: samples.map((s) => s.totalMs).sort((a, b) => a - b)[1],
        providerVerified: false,
        databaseIncluded: true,
        notes:
          'Synthetic vectors; excludes embedding inference and MCP catalog projection; no capacity limit derived',
      }),
    );
  }
} finally {
  await db.delete(user).where(eq(user.id, ownerId));
  await pool.end();
}
