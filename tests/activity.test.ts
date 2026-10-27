import { afterAll, beforeAll, expect, test } from 'vitest';
import { harness } from './harness.js';
import { fixtureMcp } from './fixtureMcp.js';

let h: Awaited<ReturnType<typeof harness>>;
let fixture: Awaited<ReturnType<typeof fixtureMcp>>;
beforeAll(async () => {
  h = await harness();
  fixture = await fixtureMcp();
});
afterAll(async () => {
  await h?.close();
  await fixture?.close();
});

test('call history filters identical tool names by stable ID and preserves owner isolation', async () => {
  const account = await h.signup();
  const other = await h.signup();
  const tools = [];
  const connectionIds: string[] = [];
  for (const name of ['first location', 'second location']) {
    const connection = await h.services.connections.create(account.ownerId, {
      name,
      adapter: 'direct',
      transport: 'http',
      mode: 'existing',
      url: fixture.url,
    });
    connectionIds.push(connection.id);
    tools.push((await h.services.connections.discover(account.ownerId, connection.id))[0]!);
  }
  const profile = (await h.services.profiles.save(account.ownerId, {
    name: 'history agent',
    toolIds: tools.map((tool) => tool.id),
  }))!;
  for (const tool of tools)
    await h.services.invocations.dispatch({
      ownerId: account.ownerId,
      profileId: profile.id,
      toolId: tool.id,
      arguments: { message: tool.id },
    });
  const response = await account.request(
    `/calls?toolId=${encodeURIComponent(tools[0]!.id)}&profileId=${profile.id}&status=succeeded`,
  );
  expect(response.status).toBe(200);
  const records = await response.json();
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({
    toolId: tools[0]!.id,
    profileId: profile.id,
    status: 'succeeded',
  });
  const detail = await account.request(`/calls/${records[0].id}`);
  expect(await detail.json()).toMatchObject({
    id: records[0].id,
    toolId: tools[0]!.id,
    connectionId: connectionIds[0],
  });
  expect((await other.request(`/calls/${records[0].id}`)).status).toBe(404);
  expect(
    await (await other.request(`/calls?toolId=${encodeURIComponent(tools[0]!.id)}`)).json(),
  ).toEqual([]);
  expect(
    await (
      await account.request(`/calls?toolId=${encodeURIComponent("missing' OR '1'='1")}`)
    ).json(),
  ).toEqual([]);
  expect(fixture.count()).toBe(2);
});
