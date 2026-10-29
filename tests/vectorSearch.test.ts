import { beforeAll, afterAll, expect, test } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { searchIndexes } from '../packages/db/src/index.js';
import { searchOptions, profileInput, manifestProfile } from '../packages/contracts/src/index.js';
import { VectorStore } from '../apps/server/src/modules/discovery/vectorStore.js';
import { HnswStore } from '../apps/server/src/modules/discovery/hnswStore.js';
import { normalize } from '../apps/server/src/modules/discovery/embeddingClient.js';
import { harness } from './harness.js';
let h: Awaited<ReturnType<typeof harness>>;
beforeAll(async () => {
  h = await harness();
});
afterAll(async () => {
  await h?.close();
});
test('new profiles filter at 0.3, legacy manifest parsing remains unfiltered', () => {
  expect(profileInput.parse({ name: 'new' }).searchOptions.minScore).toBe(0.3);
  expect(manifestProfile.parse({ name: 'old' }).searchOptions.minScore).toBeNull();
  for (const minScore of [-1, 0, 1, null])
    expect(searchOptions.parse({ minScore }).minScore).toBe(minScore);
  for (const minScore of [-1.1, 1.1, NaN])
    expect(() => searchOptions.parse({ minScore })).toThrow();
});
test('database exact search filters before limit, isolates scopes, preserves arbitrary dimensions and deterministic ties', async () => {
  const { ownerId } = await h.signup();
  const profile = (await h.services.profiles.save(ownerId, { name: 'vectors' }))!;
  const store = new VectorStore(h.db);
  const scope = { ownerId, profileId: profile.id, scope: crypto.randomUUID() };
  await store.save(scope, [
    { toolId: 'a', definitionHash: '1', vector: [1, 0] },
    { toolId: 'b', definitionHash: '2', vector: [0, 1] },
    { toolId: 'c', definitionHash: '3', vector: [-1, 0] },
    { toolId: 'd', definitionHash: '4', vector: [1, 0] },
  ]);
  const query = { ids: ['a', 'b', 'c', 'd'], vector: [1, 0], minScore: 0.3, limit: 10 };
  expect(await store.search(scope, query)).toEqual([
    { toolId: 'a', score: 1 },
    { toolId: 'd', score: 1 },
  ]);
  expect(await store.search(scope, { ...query, ids: ['b', 'c'] })).toEqual([]);
  expect(await store.search({ ...scope, scope: 'other' }, query)).toEqual([]);
  expect((await store.metadata(scope))[0]).not.toHaveProperty('vector');
  const vector = normalize(Array.from({ length: 2048 }, () => 1));
  await store.save(scope, [{ toolId: 'large', definitionHash: '5', vector }]);
  expect(
    (await store.search(scope, { ids: ['large'], vector, minScore: 0.9, limit: 1 }))[0]?.score,
  ).toBeCloseTo(1);
});
test('HNSW requires an explicit build, rejects unsupported dimensions, isolates physical candidate storage, and cleans invalid scopes', async () => {
  const { ownerId } = await h.signup();
  const profile = (await h.services.profiles.save(ownerId, { name: 'hnsw' }))!;
  const store = new VectorStore(h.db);
  const hnsw = new HnswStore(h.db);
  const scope = { ownerId, profileId: profile.id, scope: crypto.randomUUID() };
  const input = {
    ...scope,
    family: crypto.randomUUID(),
    fingerprint: 'first',
    dimensions: 3,
    options: searchOptions.parse({}).hnsw,
    ids: ['a', 'b'],
  };
  await store.save(scope, [
    { toolId: 'a', definitionHash: 'a', vector: [1, 0, 0] },
    { toolId: 'b', definitionHash: 'b', vector: [0, 1, 0] },
  ]);
  await expect(hnsw.sync(input)).rejects.toMatchObject({ code: 'SEARCH_INDEX_MISSING' });
  await expect(hnsw.build({ ...input, dimensions: 2001 })).rejects.toMatchObject({
    code: 'HNSW_DIMENSIONS',
  });
  await hnsw.build(input);
  expect((await hnsw.status(scope))?.state).toBe('ready');
  expect(
    await hnsw.search(scope, {
      ids: ['a', 'b'],
      vector: [1, 0, 0],
      minScore: 0.3,
      limit: 10,
      efSearch: 100,
    }),
  ).toEqual([{ toolId: 'a', score: 1 }]);
  expect(
    await hnsw.search(scope, {
      ids: ['b'],
      vector: [1, 0, 0],
      minScore: 0.3,
      limit: 10,
      efSearch: 100,
    }),
  ).toEqual([]);
  const record = (await hnsw.status(scope))!;
  await store.save(scope, [{ toolId: 'b', definitionHash: 'changed', vector: [1, 0, 0] }]);
  await hnsw.sync({ ...input, fingerprint: 'updated', ids: ['b'] });
  expect((await hnsw.status(scope))?.id).toBe(record.id);
  expect(
    await hnsw.search(scope, {
      ids: ['a', 'b'],
      vector: [1, 0, 0],
      minScore: 0.3,
      limit: 10,
      efSearch: 100,
    }),
  ).toEqual([{ toolId: 'b', score: 1 }]);
  await h.db
    .update(searchIndexes)
    .set({ state: 'building' })
    .where(eq(searchIndexes.id, record.id));
  await hnsw.recover();
  expect((await hnsw.status(scope))?.state).toBe('failed');
  await expect(hnsw.sync(input)).rejects.toMatchObject({ code: 'SEARCH_INDEX_NOT_READY' });
  await hnsw.build(input);
  await hnsw.cleanup({ family: input.family, scope: 'replacement' });
  expect(await hnsw.status(scope)).toBeUndefined();
  const result = await h.db.execute(
    sql`select to_regclass(${`search_hnsw_${record.id.replaceAll('-', '')}`}) as name`,
  );
  expect(result.rows[0]?.name).toBeNull();
});
