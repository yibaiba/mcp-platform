import { performance } from 'node:perf_hooks';
import { cosine, normalize } from '../apps/server/src/modules/discovery/embeddingClient.js';
const dimensions = 1536;
const query = normalize(Array.from({ length: dimensions }, (_, j) => Math.sin(j + 1)));
for (const count of [1000, 10000]) {
  const vectors = Array.from({ length: count }, (_, i) =>
    normalize(Array.from({ length: dimensions }, (_, j) => Math.sin((i + 1) * (j + 1)))),
  );
  const samples = Array.from({ length: 5 }, () => {
    const started = performance.now();
    const top = vectors
      .map((vector, index) => ({ index, score: cosine(query, vector) }))
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .slice(0, 10);
    if (top[0]?.index !== 0) throw new Error('Exact search returned an incorrect nearest vector');
    return performance.now() - started;
  });
  console.log(
    JSON.stringify({
      kind: 'local-exact-cosine-benchmark',
      tools: count,
      dimensions,
      samplesMs: samples,
      medianMs: [...samples].sort((a, b) => a - b)[2],
      providerVerified: false,
      databaseIncluded: false,
    }),
  );
}
