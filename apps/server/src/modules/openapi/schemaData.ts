const schemaMaps = new Set([
  'properties',
  'patternProperties',
  '$defs',
  'definitions',
  'dependentSchemas',
  'dependencies',
]);
const schemaChildren = new Set([
  'allOf',
  'anyOf',
  'oneOf',
  'prefixItems',
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

/** Parser instances own this set: references must never rewrite literal schema data. */
export function schemaDataMatcher() {
  const data = new WeakSet<object>();
  const visited = new WeakSet<object>();
  const schema = (value: unknown): void => {
    if (!value || typeof value !== 'object' || visited.has(value)) return;
    visited.add(value);
    for (const [key, child] of Object.entries(value)) {
      if (!child || typeof child !== 'object') continue;
      if (schemaMaps.has(key)) Object.values(child).forEach(schema);
      else if (schemaChildren.has(key)) (Array.isArray(child) ? child : [child]).forEach(schema);
      else data.add(child);
    }
  };
  const document = (value: unknown, path: string): void => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (path === '#/components/schemas' || key === 'schema') schema(child);
      else document(child, `${path}/${key}`);
    }
  };
  return (path: string, value: unknown) => {
    // Inspect the parser's objects, rather than the caller's immutable input clone.
    if (path === '#') document(value, path);
    return Boolean(value && typeof value === 'object' && data.has(value));
  };
}
