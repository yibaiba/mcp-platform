const maps = new Set([
  'properties',
  'patternProperties',
  '$defs',
  'definitions',
  'dependentSchemas',
  'dependencies',
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
const pointer = (value: string) => value.replaceAll('~', '~0').replaceAll('/', '~1');

/** Walk schema positions only: defaults, examples and const values are application data. */
function visit(
  value: unknown,
  path: string,
  transform: (schema: Record<string, unknown>, path: string) => Record<string, unknown>,
): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const schema = value as Record<string, unknown>;
  // An explicit $id owns its reference scope; relocating its fragments would change meaning.
  if (typeof schema.$id === 'string' && schema.$id) return structuredClone(schema);
  const entries = Object.entries(schema).map(([key, child]) => {
    const childPath = `${path}/${pointer(key)}`;
    if (maps.has(key) && child && typeof child === 'object' && !Array.isArray(child))
      return [
        key,
        Object.fromEntries(
          Object.entries(child).map(([name, nested]) => [
            name,
            visit(nested, `${childPath}/${pointer(name)}`, transform),
          ]),
        ),
      ];
    if ((lists.has(key) || singles.has(key)) && Array.isArray(child))
      return [key, child.map((nested, index) => visit(nested, `${childPath}/${index}`, transform))];
    if (singles.has(key)) return [key, visit(child, childPath, transform)];
    return [key, structuredClone(child)];
  });
  return transform(Object.fromEntries(entries), path);
}

export function relocateSchema(schema: unknown, component: string) {
  const root = `#/components/schemas/${pointer(component)}`;
  const anchors = new Map<string, string>();
  const dynamicAnchors = new Set<string>();
  visit(schema, root, (value, path) => {
    if (typeof value.$anchor === 'string') anchors.set(`#${value.$anchor}`, path);
    if (typeof value.$dynamicAnchor === 'string') dynamicAnchors.add(`#${value.$dynamicAnchor}`);
    return value;
  });
  return visit(schema, root, (value) => {
    const result = { ...value };
    for (const key of ['$anchor', '$dynamicAnchor'])
      if (typeof value[key] === 'string') result[key] = `${component}_${value[key]}`;
    for (const key of ['$ref', '$dynamicRef', '$recursiveRef']) {
      const ref = value[key];
      if (typeof ref !== 'string' || !ref.startsWith('#')) continue;
      const fragment = decodeURIComponent(ref.slice(1));
      if (!fragment || fragment.startsWith('/')) result[key] = `${root}${ref.slice(1)}`;
      else if (dynamicAnchors.has(`#${fragment}`)) result[key] = `#${component}_${fragment}`;
      else if (anchors.has(`#${fragment}`)) result[key] = anchors.get(`#${fragment}`);
    }
    return result;
  });
}
