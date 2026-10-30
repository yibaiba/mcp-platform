import { expect, test } from 'vitest';
import { catalogOptions } from '../packages/contracts/src/catalogOptions.js';
import {
  projectTools,
  projectContent,
  assertVisibleArguments,
} from '../apps/server/src/modules/catalog/projection.js';
const connectionId = '93bdd041-19f4-4a70-a084-688bc1c72805';
const tool = {
  id: 't_internal',
  connectionId,
  name: 'echo',
  definition: {
    name: 'echo',
    description: 'upstream',
    inputSchema: {
      type: 'object',
      properties: { required: { type: 'string' }, optional: { type: 'string' } },
      required: ['required'],
    },
  },
};
test('projection retains stable IDs and raw names while applying aliases, description and optional-parameter hiding immutably', () => {
  const original = structuredClone(tool);
  const [projected] = projectTools(
    [tool],
    catalogOptions.parse({
      tools: {
        [tool.id]: { alias: 'public_echo', description: 'custom', hiddenParameters: ['optional'] },
      },
    }),
  );
  expect(projected).toMatchObject({
    id: tool.id,
    name: 'echo',
    exposedName: 'public_echo',
    definition: { name: 'public_echo', description: 'custom' },
  });
  expect((projected!.definition.inputSchema as { properties: object }).properties).toEqual({
    required: { type: 'string' },
  });
  expect(tool).toEqual(original);
  expect(() =>
    assertVisibleArguments(projected!, { required: 'yes', optional: undefined }),
  ).toThrow(/禁止传入隐藏参数/);
  expect(() => assertVisibleArguments(projected!, { required: 'yes' })).not.toThrow();
});
test('default names remain stable and explicit prefix mode never invents names on collisions', () => {
  // Default `stable` naming is readable; with no connection name the id prefix is the slug.
  expect(projectTools([tool], catalogOptions.parse({}))[0]?.exposedName).toBe('c93bdd0__echo');
  expect(
    projectTools([tool], catalogOptions.parse({}), new Map([[connectionId, 'Docs']]))[0]
      ?.exposedName,
  ).toBe('docs__echo');
  expect(
    projectTools([tool], catalogOptions.parse({ toolNaming: 'original' }))[0]?.exposedName,
  ).toBe('echo');
  expect(
    projectTools(
      [tool],
      catalogOptions.parse({
        toolNaming: 'prefixed',
        connectionAliases: { [connectionId]: 'docs' },
      }),
    )[0]?.exposedName,
  ).toBe('docs_echo');
  expect(() => projectTools([tool], catalogOptions.parse({ toolNaming: 'prefixed' }))).toThrow(
    /尚未设置展示前缀/,
  );
  expect(() =>
    projectTools(
      [tool, { ...tool, id: 't_other' }],
      catalogOptions.parse({ toolNaming: 'original' }),
    ),
  ).toThrow(/展示名冲突/);
  expect(() =>
    projectTools(
      [tool],
      catalogOptions.parse({ tools: { [tool.id]: { alias: 'platform_tools_search' } } }),
    ),
  ).toThrow(/展示名冲突/);
});
test('required, nonexistent and indirectly required parameters cannot be presented as hidden optional parameters', () => {
  for (const hidden of ['required', 'missing'])
    expect(() =>
      projectTools(
        [tool],
        catalogOptions.parse({ tools: { [tool.id]: { hiddenParameters: [hidden] } } }),
      ),
    ).toThrow();
  const composite = {
    ...tool,
    definition: {
      ...tool.definition,
      inputSchema: { ...tool.definition.inputSchema, allOf: [{ required: ['optional'] }] },
    },
  };
  expect(() =>
    projectTools(
      [composite],
      catalogOptions.parse({ tools: { [tool.id]: { hiddenParameters: ['optional'] } } }),
    ),
  ).toThrow(/可选性/);
});
test('content description overrides preserve internal identifiers and upstream definitions', () => {
  const entry = {
    id: 'resource_internal',
    definition: { uri: 'file:///public', description: 'upstream' },
  };
  const projected = projectContent(
    [entry],
    catalogOptions.parse({ content: { [entry.id]: { description: '' } } }),
  );
  expect(projected[0]).toEqual({
    id: entry.id,
    definition: { uri: 'file:///public', description: '' },
  });
  expect(entry.definition.description).toBe('upstream');
});
