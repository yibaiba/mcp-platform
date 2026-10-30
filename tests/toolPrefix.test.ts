import { afterAll, beforeAll, expect, test } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import {
  connectionInput,
  connectionToolPrefix,
  nameNeedsToolPrefix,
  suggestToolPrefix,
} from '../packages/contracts/src/index.js';
import { catalogOptions } from '../packages/contracts/src/catalogOptions.js';
import {
  type ConnectionLabel,
  readableToolNames,
  TOOL_NAME_MAX,
} from '../apps/server/src/modules/catalog/toolNames.js';
import { toolId } from '../apps/server/src/modules/mcp/catalogRepository.js';
import { projectTools } from '../apps/server/src/modules/catalog/projection.js';
import { harness } from './harness.js';
import { fixtureMcp } from './fixtureMcp.js';

const a = '3595bf11-1111-4111-8111-111111111111';
const b = '22222222-2222-4222-8222-222222222222';
const tool = (connectionId: string, name: string) => ({
  id: toolId(connectionId, name),
  connectionId,
  name,
  definition: { name, inputSchema: { type: 'object' } },
});

test("a user-set English prefix replaces only that connection's prefix; absent keeps old names", () => {
  const tools = [tool(a, 'echo'), tool(b, 'echo')];
  const before = readableToolNames(
    tools,
    new Map([
      [a, '团队知识库'],
      [b, 'Docs'],
    ]),
    new Set(),
  );
  expect([...before.values()]).toEqual(['c3595bf__echo', 'docs__echo']);
  // Upgrade path: a row with no prefix (null column) yields exactly the old names.
  const upgraded = readableToolNames(
    tools,
    new Map([
      [a, { name: '团队知识库', prefix: null }],
      [b, { name: 'Docs' }],
    ]),
    new Set(),
  );
  expect(upgraded).toEqual(before);
  const named = readableToolNames(
    tools,
    new Map<string, ConnectionLabel>([
      [a, { name: '团队知识库', prefix: 'team_kb' }],
      [b, 'Docs'],
    ]),
    new Set(),
  );
  expect(named.get(tools[0]!.id)).toBe('team_kb__echo');
  expect(named.get(tools[1]!.id)).toBe('docs__echo');
});

test('a prefix that collides with another connection resolves deterministically and stays ≤48', () => {
  const tools = [tool(a, 'echo'), tool(b, 'echo'), tool(a, 'x'.repeat(80))];
  const labels = new Map([
    [a, { name: '团队知识库', prefix: 'docs' }],
    [b, { name: 'Docs' }],
  ]);
  const first = projectTools(tools, catalogOptions.parse({}), labels).map((t) => t.exposedName);
  const second = projectTools([...tools].reverse(), catalogOptions.parse({}), labels)
    .map((t) => t.exposedName)
    .reverse();
  expect(second).toEqual(first);
  expect(new Set(first).size).toBe(3);
  expect(first.filter((name) => name === 'docs__echo')).toHaveLength(1);
  for (const name of first) {
    expect(name.length).toBeLessThanOrEqual(TOOL_NAME_MAX);
    expect(name).toMatch(/^[A-Za-z0-9_-]+$/);
  }
});

test('prefix validation, clearing and suggestions', () => {
  const base = {
    name: '团队知识库',
    adapter: 'direct',
    transport: 'http',
    mode: 'existing',
    url: 'https://kb.example.com/mcp',
  };
  expect(connectionInput.parse({ ...base, toolPrefix: 'team_kb' }).toolPrefix).toBe('team_kb');
  expect(connectionInput.parse({ ...base, toolPrefix: '  ' }).toolPrefix).toBeUndefined();
  expect(connectionInput.parse(base).toolPrefix).toBeUndefined();
  for (const bad of ['Team', 'team kb', 'team__kb', '_kb', 'kb-', '知识库', 'a'.repeat(21)])
    expect(connectionInput.safeParse({ ...base, toolPrefix: bad }).success).toBe(false);
  expect(nameNeedsToolPrefix('团队知识库')).toBe(true);
  expect(nameNeedsToolPrefix('GitHub')).toBe(false);
  expect(connectionToolPrefix(a, '团队知识库')).toBe('c3595bf');
  expect(connectionToolPrefix(a, '团队知识库', 'team_kb')).toBe('team_kb');
  expect(suggestToolPrefix({ name: 'GitHub Issues' })).toBe('github_issues');
  expect(suggestToolPrefix({ name: '团队知识库', url: 'https://kb.example.com/mcp' })).toBe('kb');
  expect(suggestToolPrefix({ name: '团队', url: 'http://127.0.0.1:3000/notes/mcp' })).toBe('notes');
  expect(
    suggestToolPrefix({
      name: '文件',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
    }),
  ).toBe('filesystem');
  expect(suggestToolPrefix({ name: '笔记', command: 'node', args: ['/srv/notes-mcp.mjs'] })).toBe(
    'notes',
  );
  expect(suggestToolPrefix({ name: '团队' })).toBe('');
});

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

test('setting an English prefix renames tools for clients; t_ names stay callable; clearing restores', async () => {
  const account = await h.signup();
  const created = await account.request('/connections', {
    method: 'POST',
    body: JSON.stringify({
      name: '团队知识库',
      adapter: 'direct',
      transport: 'http',
      mode: 'existing',
      url: fixture.url,
    }),
  });
  expect(created.status).toBe(201);
  const connection = (await created.json()) as { id: string; revision: number };
  const [echo] = await h.services.connections.discover(account.ownerId, connection.id);
  const profile = (await h.services.profiles.save(account.ownerId, {
    name: '知识库助手',
    toolIds: [echo!.id],
  }))!;
  const key = await h.services.profiles.issue(account.ownerId, profile.id);
  const list = async () => {
    const client = new Client({ name: 'prefix-test', version: '1' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${h.baseURL}/mcp/${profile.id}`), {
        requestInit: { headers: { Authorization: `Bearer ${key.token}` } },
      }),
    );
    return client;
  };
  const original = `c${connection.id.replace(/-/g, '').slice(0, 6)}__echo`;
  let client = await list();
  expect((await client.listTools()).tools.map((t) => t.name)).toEqual([original]);
  await client.close();

  const invalid = await account.request(`/connections/${connection.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ toolPrefix: 'Team KB', revision: connection.revision }),
  });
  expect(invalid.status).toBe(400);

  const saved = await account.request(`/connections/${connection.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ toolPrefix: 'team_kb', revision: connection.revision }),
  });
  expect(saved.status).toBe(200);
  const listed = (await (await account.request('/connections')).json()) as {
    id: string;
    toolPrefix: string | null;
    revision: number;
  }[];
  const row = listed.find((item) => item.id === connection.id)!;
  expect(row.toolPrefix).toBe('team_kb');
  await h.services.connections.discover(account.ownerId, connection.id);
  client = await list();
  try {
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(['team_kb__echo']);
    const call = (name: string) => client.callTool({ name, arguments: { message: 'hi' } });
    expect((await call('team_kb__echo')).isError).toBeFalsy();
    // Legacy t_<sha256> ids keep working; the previous readable name is gone.
    expect((await call(echo!.id)).isError).toBeFalsy();
    const old = await call(original).catch((error: unknown) => ({ isError: true, error }));
    expect(old.isError).toBe(true);
  } finally {
    await client.close();
  }

  const cleared = await account.request(`/connections/${connection.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ toolPrefix: '', revision: row.revision }),
  });
  expect(cleared.status).toBe(200);
  await h.services.connections.discover(account.ownerId, connection.id);
  client = await list();
  expect((await client.listTools()).tools.map((t) => t.name)).toEqual([original]);
  await client.close();
});
