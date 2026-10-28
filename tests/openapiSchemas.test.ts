import { expect, test } from 'vitest';
import { relocateSchema } from '../apps/server/src/modules/rest/schemaReferences.js';
import { validateOpenApiDocument } from '../apps/server/src/modules/openapi/importService.js';
import { compileDocument } from '../apps/server/src/modules/openapi/compile.js';
import type { ApiDocument } from '../apps/server/src/modules/openapi/types.js';
import { parseTool, validateToolValue } from '../packages/mcp/src/index.js';

test('OpenAPI component references isolate each tool and resolve definitions and escaped pointers', async () => {
  const schema = {
    type: 'object',
    properties: { payload: { $ref: '#/$defs/a~1b~0c' } },
    $defs: { 'a/b~c': { type: 'string' } },
    default: { $ref: '#/application-data' },
  };
  const first = relocateSchema(schema, 'First');
  const second = relocateSchema(schema, 'Second');
  const doc = {
    openapi: '3.1.0',
    info: { title: 'Tools', version: '1' },
    paths: {},
    components: { schemas: { First: first, Second: second } },
  };
  expect(first).toMatchObject({
    properties: { payload: { $ref: '#/components/schemas/First/$defs/a~1b~0c' } },
  });
  expect(second).toMatchObject({
    properties: { payload: { $ref: '#/components/schemas/Second/$defs/a~1b~0c' } },
  });
  await expect(validateOpenApiDocument(doc)).resolves.toMatchObject({
    components: {
      schemas: { First: { default: schema.default }, Second: { default: schema.default } },
    },
  });
  expect(first).toMatchObject({ default: { $ref: '#/application-data' } });
  expect(schema.properties.payload.$ref).toBe('#/$defs/a~1b~0c');
});

test('empty IDs retain document scope and exported references resolve', async () => {
  const input = {
    $id: '',
    type: 'object',
    properties: { value: { $ref: '#/$defs/Value' } },
    $defs: { Value: { type: 'string' } },
  };
  const exported = relocateSchema(input, 'EmptyId');
  expect(exported).toMatchObject({
    properties: { value: { $ref: '#/components/schemas/EmptyId/$defs/Value' } },
  });
  await expect(
    validateOpenApiDocument({
      openapi: '3.1.0',
      info: { title: 'Empty ID', version: '1' },
      paths: {},
      components: { schemas: { EmptyId: exported } },
    }),
  ).resolves.toBeDefined();
});

test.each(['#/components/schemas/Value', '#/missing-data', 'https://example.invalid/data'])(
  'dereferencing keeps literal ref %s and the compiled tool accepts the original data',
  async (reference) => {
    const literal = { $ref: reference };
    const input = {
      type: 'object',
      required: ['ref'],
      properties: {
        ref: { const: literal, default: literal, examples: [literal], enum: [literal] },
      },
    };
    const parsed = await validateOpenApiDocument({
      openapi: '3.1.0',
      info: { title: 'Literal data', version: '1' },
      components: { schemas: { Value: { type: 'string' }, Input: input } },
      paths: {
        '/literal': {
          post: {
            requestBody: {
              required: true,
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Input' } } },
            },
            responses: { '200': { description: 'OK' } },
          },
        },
      },
    });
    const [operation] = compileDocument(parsed as ApiDocument);
    const tool = parseTool({ name: 'literal', inputSchema: operation!.inputSchema });
    expect(() =>
      validateToolValue({ tool, field: 'inputSchema', value: { body: { ref: literal } } }),
    ).not.toThrow();
    expect(() =>
      validateToolValue({
        tool,
        field: 'inputSchema',
        value: { body: { ref: { type: 'string' } } },
      }),
    ).toThrow();
    expect(parsed).toMatchObject({ components: { schemas: { Input: input } } });
  },
);

test('root and recursive pointers relocate while independent IDs and data remain unchanged', () => {
  const resource = {
    $id: 'https://example.test/nested',
    $defs: { value: { type: 'string' } },
    $ref: '#/$defs/value',
  };
  const schema = {
    $ref: '#',
    definitions: { recursive: { $ref: '#/definitions/recursive' }, resource },
    examples: [{ $ref: '#/data' }],
    const: { $ref: '#' },
  };
  expect(relocateSchema(schema, 'Tool')).toEqual({
    ...schema,
    $ref: '#/components/schemas/Tool',
    definitions: {
      recursive: { $ref: '#/components/schemas/Tool/definitions/recursive' },
      resource,
    },
  });
  expect(relocateSchema(resource, 'Tool')).toEqual(resource);
});

test('anchors resolve in schema positions and external references keep their URI', () => {
  expect(
    relocateSchema(
      {
        $defs: { item: { $anchor: 'item', type: 'string' } },
        properties: {
          item: { $ref: '#item' },
          external: { $ref: 'https://example.test/schema#item' },
        },
      },
      'Tool',
    ),
  ).toMatchObject({
    properties: {
      item: { $ref: '#/components/schemas/Tool/$defs/item' },
      external: { $ref: 'https://example.test/schema#item' },
    },
  });
});

test('encoded fragments and dynamic anchors retain meaning without cross-tool collisions', () => {
  const schema = {
    $dynamicAnchor: 'node',
    properties: {
      nested: { $dynamicRef: '#node' },
      local: { $ref: '#%2F$defs%2FNode' },
      anchored: { $ref: '#%69tem' },
    },
    $defs: { Node: { type: 'object' }, Item: { $anchor: 'item', type: 'string' } },
  };
  for (const name of ['First', 'Second'])
    expect(relocateSchema(schema, name)).toMatchObject({
      $dynamicAnchor: `${name}_node`,
      properties: {
        nested: { $dynamicRef: `#${name}_node` },
        local: { $ref: `#/components/schemas/${name}%2F$defs%2FNode` },
        anchored: { $ref: `#/components/schemas/${name}/$defs/Item` },
      },
      $defs: { Item: { $anchor: `${name}_item` } },
    });
});
