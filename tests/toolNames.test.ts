import { expect, test } from 'vitest';
import { catalogOptions } from '../packages/contracts/src/catalogOptions.js';
import { projectTools } from '../apps/server/src/modules/catalog/projection.js';
import {
  TOOL_NAME_MAX,
  legacyToolName,
  readableToolNames,
} from '../apps/server/src/modules/catalog/toolNames.js';
import { toolId } from '../apps/server/src/modules/mcp/catalogRepository.js';

const a = '11111111-1111-4111-8111-111111111111';
const b = '22222222-2222-4222-8222-222222222222';
const tool = (connectionId: string, name: string) => ({
  id: toolId(connectionId, name),
  connectionId,
  name,
  definition: { name, inputSchema: { type: 'object' } },
});
const valid = /^[A-Za-z0-9_-]+$/;

test('readable names are connslug__tool, charset-limited and at most 48 characters', () => {
  const names = new Map([
    [a, 'GitHub Enterprise (Prod) — 东京'],
    [b, '文档'],
  ]);
  const tools = [
    tool(a, 'search_issues'),
    tool(a, 'x'.repeat(200)),
    tool(a, 'emoji 🚀 / tool.name:v2'),
    tool(b, '读取文件'),
  ];
  const result = readableToolNames(tools, names, new Set());
  for (const name of result.values()) {
    expect(name.length).toBeLessThanOrEqual(TOOL_NAME_MAX);
    expect(name).toMatch(valid);
    expect(legacyToolName.test(name)).toBe(false);
  }
  expect(result.get(tools[0]!.id)).toBe('github_enterprise_pr__search_issues');
  expect(result.get(tools[1]!.id)).toHaveLength(TOOL_NAME_MAX);
  expect(result.get(tools[1]!.id)).toMatch(/^github_enterprise_pr__x+_[0-9a-f]{6}$/);
  expect(result.get(tools[2]!.id)).toBe('github_enterprise_pr__emoji_tool_name_v2');
  // Non-ASCII names fall back to stable id prefixes instead of disappearing.
  expect(result.get(tools[3]!.id)).toMatch(/^c222222__t[0-9a-f]{6}$/);
});

test('the same input always yields the same names regardless of order', () => {
  const tools = [tool(a, 'echo'), tool(b, 'echo'), tool(a, 'list'), tool(b, 'y'.repeat(90))];
  const names = new Map([
    [a, 'docs'],
    [b, 'docs'],
  ]);
  const first = readableToolNames(tools, names, new Set());
  const second = readableToolNames([...tools].reverse(), names, new Set());
  expect([...second.entries()].sort()).toEqual([...first.entries()].sort());
  expect(readableToolNames(tools, names, new Set())).toEqual(first);
});

test('collisions resolve by ascending stable id: first keeps the plain name, later ones get a hash suffix', () => {
  const tools = [tool(a, 'echo'), tool(b, 'echo')];
  const names = new Map([
    [a, 'docs'],
    [b, 'docs'],
  ]);
  const result = readableToolNames(tools, names, new Set());
  const [low, high] = [...tools].sort((x, y) => (x.id < y.id ? -1 : 1));
  expect(result.get(low!.id)).toBe('docs__echo');
  expect(result.get(high!.id)).toMatch(/^docs__echo_[0-9a-f]{6}$/);
  expect(new Set(result.values()).size).toBe(2);
  // Reserved/alias names are treated as taken, never reused.
  const reserved = readableToolNames([tool(a, 'echo')], names, new Set(['docs__echo']));
  expect(reserved.get(tool(a, 'echo').id)).toMatch(/^docs__echo_[0-9a-f]{6}$/);
});

test('projection keeps aliases authoritative and never yields duplicate default names', () => {
  const tools = [tool(a, 'echo'), tool(b, 'echo'), tool(a, 'other')];
  const names = new Map([
    [a, 'docs'],
    [b, 'docs'],
  ]);
  const projected = projectTools(
    tools,
    catalogOptions.parse({ tools: { [tools[2]!.id]: { alias: 'docs__echo' } } }),
    names,
  );
  const exposed = projected.map((row) => row.exposedName);
  expect(exposed[2]).toBe('docs__echo');
  expect(new Set(exposed).size).toBe(3);
  for (const name of exposed) {
    expect(name.length).toBeLessThanOrEqual(TOOL_NAME_MAX);
    expect(name).toMatch(valid);
  }
  // A single row resolved against its full set matches the listing.
  const single = projectTools([tools[1]!], catalogOptions.parse({}), names, tools);
  expect(single[0]!.exposedName).toBe(
    projectTools(tools, catalogOptions.parse({}), names)[1]!.exposedName,
  );
});
