import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { eq, sql } from 'drizzle-orm';
import { createDatabase, user, profiles } from '../packages/db/src/index.js';
import { VectorStore } from '../apps/server/src/modules/discovery/vectorStore.js';
import { HnswStore } from '../apps/server/src/modules/discovery/hnswStore.js';
import { normalize } from '../apps/server/src/modules/discovery/embeddingClient.js';
const TOOL_COUNT = 10_000,
  DIMENSIONS = 1536,
  QUERIES = 30,
  BATCH = 128;
if (!process.env.DATABASE_URL) throw new Error('Set an isolated, migrated DATABASE_URL');
const { db, pool } = createDatabase(process.env.DATABASE_URL);
const ownerId = randomUUID(),
  scope = { ownerId, profileId: randomUUID(), scope: randomUUID() };
const vectors = new VectorStore(db),
  hnsw = new HnswStore(db);
const family = randomUUID();
let seed = 20261029;
const random = () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 2 ** 32 - 0.5;
};
const centers = Array.from({ length: 64 }, () => Array.from({ length: DIMENSIONS }, random));
const rows = Array.from({ length: TOOL_COUNT }, (_, index) => ({
  toolId: `tool-${index.toString().padStart(5, '0')}`,
  definitionHash: String(index),
  vector: normalize(centers[index % centers.length]!.map((v) => v + random() * 0.25)),
}));
const queries = Array.from({ length: QUERIES }, (_, index) =>
  normalize(rows[index * 313]!.vector.map((v) => v + random() * 0.001)),
);
const p95 = (values: number[]) =>
  [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1]!;
try {
  await db
    .insert(user)
    .values({ id: ownerId, name: 'Search benchmark', email: `${ownerId}@benchmark.invalid` });
  await db.insert(profiles).values({ id: scope.profileId, ownerId, name: 'Isolated benchmark' });
  for (let offset = 0; offset < rows.length; offset += BATCH)
    await vectors.save(scope, rows.slice(offset, offset + BATCH));
  console.log(
    'Seeded 10000 tools at 1536 dimensions; synthetic clustered corpus, not a provider quality test.',
  );
  const ids = rows.map((row) => row.toolId);
  await hnsw.build({
    ...scope,
    family,
    fingerprint: 'benchmark',
    dimensions: DIMENSIONS,
    options: { m: 16, efConstruction: 64, efSearch: 100 },
    ids,
  });
  const exactMs: number[] = [],
    hnswMs: number[] = [],
    recall: number[] = [];
  for (const vector of [queries[0]!, ...queries]) {
    const query = { ids, vector, limit: 10, minScore: null };
    let start = performance.now();
    const exact = await vectors.search(scope, query);
    const exactTime = performance.now() - start;
    start = performance.now();
    const approximate = await hnsw.search(scope, { ...query, efSearch: 100 });
    const approximateTime = performance.now() - start;
    const correct = new Set(exact.map((row) => row.toolId));
    exactMs.push(exactTime);
    hnswMs.push(approximateTime);
    recall.push(approximate.filter((row) => correct.has(row.toolId)).length / 10);
  }
  exactMs.shift();
  hnswMs.shift();
  recall.shift();
  const report = {
    environment: (
      await db.execute(
        sql`select version(), (select extversion from pg_extension where extname = 'vector') as pgvector`,
      )
    ).rows[0],
    tools: TOOL_COUNT,
    dimensions: DIMENSIONS,
    queries: QUERIES,
    scope: 'database retrieval only; excludes authorization, indexing, embedding and serialization',
    exact: { p95Ms: p95(exactMs), samplesMs: exactMs },
    hnsw: {
      p95Ms: p95(hnswMs),
      recallAt10: recall.reduce((a, b) => a + b, 0) / QUERIES,
      samplesMs: hnswMs,
    },
  };
  console.log(JSON.stringify(report, null, 2));
  if (report.exact.p95Ms > 1000 || report.hnsw.p95Ms > 300 || report.hnsw.recallAt10 < 0.95)
    process.exitCode = 1;
} finally {
  await hnsw.cleanup({ family, scope: 'finished' });
  await db.delete(user).where(eq(user.id, ownerId));
  await pool.end();
}
