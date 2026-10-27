import type { Tool } from '@modelcontextprotocol/client';

const maps = new Set([
  'properties',
  'patternProperties',
  '$defs',
  'definitions',
  'dependentSchemas',
]);
const lists = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems']);
const singles = new Set([
  'items',
  'additionalItems',
  'additionalProperties',
  'unevaluatedProperties',
  'unevaluatedItems',
  'contains',
  'not',
  'if',
  'then',
  'else',
  'propertyNames',
  'contentSchema',
]);

function objectSchemas(value: unknown): unknown {
  if (value === true) return {};
  if (value === false) return { not: {} };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => {
      if (maps.has(key) && child && typeof child === 'object' && !Array.isArray(child))
        return [
          key,
          Object.fromEntries(
            Object.entries(child).map(([name, schema]) => [name, objectSchemas(schema)]),
          ),
        ];
      if (lists.has(key) && Array.isArray(child)) return [key, child.map(objectSchemas)];
      if (singles.has(key))
        return [key, Array.isArray(child) ? child.map(objectSchemas) : objectSchemas(child)];
      return [key, child];
    }),
  );
}

// Older SDK wire schemas reject boolean child schemas even though JSON Schema permits them.
// These rewrites preserve validation semantics and leave data-valued keywords untouched.
export function legacyToolDefinition(tool: Tool): Tool {
  return {
    ...tool,
    inputSchema: objectSchemas(tool.inputSchema) as Tool['inputSchema'],
    ...(tool.outputSchema
      ? { outputSchema: objectSchemas(tool.outputSchema) as Tool['outputSchema'] }
      : {}),
  };
}
