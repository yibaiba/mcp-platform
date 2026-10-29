import { sql } from 'drizzle-orm';
import { harness } from '../tests/harness.js';
import { HnswStore } from '../apps/server/src/modules/discovery/hnswStore.js';
import {
  searchCorpus,
  benchmarkFixture,
  TOOL_COUNT,
  DIMENSIONS,
  QUERY_COUNT,
} from './search-benchmark-fixture.mjs';
const fixture = await benchmarkFixture(searchCorpus());
const h = await harness();
let family: string | undefined;
const p95 = (values: number[]) =>
  [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1]!;
try {
  const { ownerId } = await h.signup();
  const connection = await h.services.connections.create(ownerId, {
    name: 'performance',
    adapter: 'direct',
    mode: 'existing',
    transport: 'http',
    url: `${fixture.url}/mcp`,
  });
  const tools = await h.services.connections.discover(ownerId, connection.id);
  const profile = (await h.services.profiles.save(ownerId, {
    name: 'performance',
    toolIds: tools.map((tool) => tool.id),
    discoveryMode: 'search',
    embedding: {
      baseUrl: `${fixture.url}/v1`,
      model: 'synthetic-clustered-fixture',
      dimensions: DIMENSIONS,
    },
    catalog: { toolNaming: 'original' },
    searchOptions: { strategy: 'exact', minScore: null },
  }))!;
  const query = (index: number) =>
    h.services.discovery.searchDetailed(ownerId, {
      profileId: profile.id,
      query: `query:${index}`,
      limit: 10,
    });
  await query(0);
  const exact: Awaited<ReturnType<typeof query>>[] = [],
    approximate: typeof exact = [];
  for (let index = 0; index < QUERY_COUNT; index++) exact.push(await query(index));
  await h.services.profiles.save(
    ownerId,
    {
      name: profile.name,
      toolIds: profile.toolIds,
      searchOptions: { strategy: 'hnsw', minScore: null },
    },
    profile.id,
  );
  const status = await h.services.discovery.rebuild(ownerId, profile.id);
  if ('family' in status.hnsw) family = status.hnsw.family;
  await query(0);
  for (let index = 0; index < QUERY_COUNT; index++) approximate.push(await query(index));
  const summarize = (samples: typeof exact) => ({
    totalP95Ms: p95(samples.map((sample) => sample.durationMs)),
    phasesP95Ms: Object.fromEntries(
      Object.keys(samples[0]!.timingsMs).map((phase) => [
        phase,
        p95(samples.map((sample) => sample.timingsMs[phase as keyof typeof sample.timingsMs])),
      ]),
    ),
    samples: samples.map((sample) => ({ durationMs: sample.durationMs, ...sample.timingsMs })),
  });
  const recall =
    approximate.reduce((sum, sample, index) => {
      const expected = new Set(exact[index]!.hits.map((hit) => hit.toolId));
      return sum + sample.hits.filter((hit) => expected.has(hit.toolId)).length / 10;
    }, 0) / QUERY_COUNT;
  const report = {
    kind: 'discoveryBenchmark',
    tools: TOOL_COUNT,
    dimensions: DIMENSIONS,
    hotQueries: QUERY_COUNT,
    embedding: 'Real HTTP deterministic protocol fixture; not supplier/model validation',
    environment: (
      await h.db.execute(
        sql`select version(), current_setting('shared_buffers') as shared_buffers, current_setting('maintenance_work_mem') as maintenance_work_mem`,
      )
    ).rows[0],
    exact: summarize(exact),
    hnsw: summarize(approximate),
    recallAt10: recall,
    businessCalls: fixture.businessCalls(),
  };
  console.log(JSON.stringify(report));
  if (
    report.exact.phasesP95Ms.retrieval! > 1000 ||
    report.hnsw.phasesP95Ms.retrieval! > 300 ||
    recall < 0.95 ||
    report.businessCalls !== 0
  )
    process.exitCode = 1;
} finally {
  if (family) await new HnswStore(h.db).cleanup({ family, scope: 'benchmark-finished' });
  await h.close();
  await fixture.close();
}
