import { afterAll, beforeAll, expect, test } from 'vitest';
import { hiddenValue, toolAnnotations, toolSafety } from '../packages/contracts/src/index.js';
import { harness } from './harness.js';
import { fixtureMcp } from './fixtureMcp.js';

// Tool annotations reach both pickers, and env / headers are masked on read and kept on save.
let h: Awaited<ReturnType<typeof harness>>;
let upstream: Awaited<ReturnType<typeof fixtureMcp>>;
let admin: Awaited<ReturnType<typeof h.signup>>;
let member: typeof admin;
const SECRET = 'Bearer filter-test-secret';
const ENV_SECRET = 'env-filter-test-secret';
const schema = { type: 'object', properties: {} };
beforeAll(async () => {
  h = await harness();
  upstream = await fixtureMcp({
    extraTools: [
      { name: 'list_rows', inputSchema: schema, annotations: { readOnlyHint: true } },
      { name: 'append_row', inputSchema: schema, annotations: { destructiveHint: false } },
      { name: 'drop_table', inputSchema: schema, annotations: { destructiveHint: true } },
      { name: 'write_maybe', inputSchema: schema, annotations: { readOnlyHint: false } },
    ],
  });
  admin = await h.signup({ role: 'admin' });
  member = await h.signup();
});
afterAll(async () => {
  await h?.close();
  await upstream?.close();
});

async function create(extra: Record<string, unknown> = {}) {
  const connection = await h.services.connections.create(admin.ownerId, {
    name: `filter ${Math.random()}`,
    adapter: 'direct',
    transport: 'http',
    mode: 'existing',
    url: upstream.url,
    headers: { Authorization: SECRET, 'X-Trace': 'trace-1' },
    env: { API_TOKEN: ENV_SECRET },
    ...extra,
  });
  return connection;
}
const stored = async (id: string) =>
  (await h.services.connections.context(admin.ownerId, id)).config;
const patch = (id: string, body: Record<string, unknown>) =>
  admin.request(`/connections/${id}`, { method: 'PATCH', body: JSON.stringify(body) });

test('the share catalog and the Agent tool list carry annotations; safety is derived from them', async () => {
  const connection = await create();
  await h.services.connections.discover(admin.ownerId, connection.id);
  const catalog = (await (
    await admin.request(`/connections/${connection.id}/shares/catalog`)
  ).json()) as {
    tools: {
      id: string;
      name: string;
      annotations?: Record<string, unknown>;
      definition?: unknown;
    }[];
  };
  const safety = Object.fromEntries(
    catalog.tools.map((tool) => [tool.name, toolSafety(tool.annotations)]),
  );
  expect(safety).toEqual({
    echo: 'undeclared',
    list_rows: 'readOnly',
    append_row: 'additive',
    drop_table: 'destructive',
    write_maybe: 'destructive',
  });
  // Only the annotations are added, not the whole definition.
  expect(catalog.tools.every((tool) => tool.definition === undefined)).toBe(true);

  const team = await admin.request(`/connections/${connection.id}/team-share`, {
    method: 'PUT',
    body: JSON.stringify({
      credentialMode: 'owner',
      toolIds: catalog.tools.map((tool) => tool.id),
    }),
  });
  expect(team.status).toBe(200);
  const memberTools = (await (await member.request('/tools')).json()) as {
    name: string;
    connectionId: string;
    definition: unknown;
  }[];
  const shared = memberTools.filter((tool) => tool.connectionId === connection.id);
  expect(
    Object.fromEntries(
      shared.map((tool) => [tool.name, toolSafety(toolAnnotations(tool.definition))]),
    ),
  ).toEqual(safety);
});

test('env and header keys come from a dedicated endpoint with every value hidden; the list names none', async () => {
  const connection = await create();
  const response = await admin.request(`/connections/${connection.id}/key-values`);
  expect(response.status).toBe(200);
  const text = await response.text();
  for (const value of [SECRET, ENV_SECRET, 'trace-1']) expect(text).not.toContain(value);
  expect(JSON.parse(text)).toEqual({
    headers: { Authorization: hiddenValue, 'X-Trace': hiddenValue },
    env: { API_TOKEN: hiddenValue },
  });
  for (const path of ['/connections', `/connections/${connection.id}`]) {
    const listed = await (await admin.request(path)).text();
    for (const value of [SECRET, ENV_SECRET, 'API_TOKEN', 'X-Trace', hiddenValue])
      expect(listed).not.toContain(value);
  }
  // Another account cannot read the keys.
  expect((await member.request(`/connections/${connection.id}/key-values`)).status).toBe(404);
});

test('saving placeholders keeps stored values; changed and added rows are saved; untouched maps stay as they were', async () => {
  const connection = await create({ headers: { Authorization: SECRET, 'legacy header': 'kept' } });
  // An edit that does not touch the maps (the form sends nothing for untouched editors).
  let response = await patch(connection.id, { name: 'renamed', revision: 1 });
  expect(response.status).toBe(200);
  expect((await stored(connection.id)).headers).toEqual({
    Authorization: SECRET,
    'legacy header': 'kept',
  });
  expect((await stored(connection.id)).env).toEqual({ API_TOKEN: ENV_SECRET });

  response = await patch(connection.id, {
    revision: 2,
    headers: { Authorization: hiddenValue, 'legacy header': hiddenValue, 'X-Added': 'new' },
    env: { API_TOKEN: hiddenValue, MODE: 'debug' },
  });
  expect(response.status).toBe(200);
  expect((await stored(connection.id)).headers).toEqual({
    Authorization: SECRET,
    'legacy header': 'kept',
    'X-Added': 'new',
  });
  expect((await stored(connection.id)).env).toEqual({ API_TOKEN: ENV_SECRET, MODE: 'debug' });

  // Removing a row removes it; replacing a value replaces it.
  response = await patch(connection.id, {
    revision: 3,
    headers: { Authorization: 'Bearer replaced' },
  });
  expect(response.status).toBe(200);
  expect((await stored(connection.id)).headers).toEqual({ Authorization: 'Bearer replaced' });

  // A placeholder moved to a key that was never stored cannot be matched to a value.
  response = await patch(connection.id, { revision: 4, env: { RENAMED: hiddenValue } });
  expect(response.status).toBe(400);
  expect(await response.text()).toContain('改了名字的项需要重新填写值');
  expect((await stored(connection.id)).env).toEqual({ API_TOKEN: ENV_SECRET, MODE: 'debug' });
});
