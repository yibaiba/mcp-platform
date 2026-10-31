/**
 * What a tool says about its side effects, from MCP tool annotations. Annotations are hints the
 * upstream reports about itself: they drive labels and bulk selection, never authorization.
 *
 * - `readOnly`: `readOnlyHint: true`.
 * - `additive`: `readOnlyHint` is not true and `destructiveHint: false` (it changes things, but
 *   only adds or updates without destroying).
 * - `destructive`: `destructiveHint: true`, or `readOnlyHint: false` with no `destructiveHint`
 *   (the MCP default for a non-read-only tool is destructive).
 * - `undeclared`: neither hint is given. Treated like `destructive` by the bulk actions, since
 *   MCP's defaults for a tool without annotations are "not read-only" and "may destroy".
 */
export type ToolSafety = 'readOnly' | 'additive' | 'destructive' | 'undeclared';

export const toolSafetyOrder: readonly ToolSafety[] = [
  'readOnly',
  'additive',
  'destructive',
  'undeclared',
];

export const toolSafetyLabels: Record<ToolSafety, string> = {
  readOnly: '只读',
  additive: '会修改（非破坏性）',
  destructive: '破坏性',
  undeclared: '未声明',
};

export type ToolAnnotations = {
  readOnlyHint?: unknown;
  destructiveHint?: unknown;
  idempotentHint?: unknown;
  openWorldHint?: unknown;
  [key: string]: unknown;
};

/** The annotations object of a stored tool definition, or undefined when absent or malformed. */
export function toolAnnotations(definition: unknown): ToolAnnotations | undefined {
  if (!definition || typeof definition !== 'object') return undefined;
  const annotations = (definition as { annotations?: unknown }).annotations;
  return annotations && typeof annotations === 'object' && !Array.isArray(annotations)
    ? (annotations as ToolAnnotations)
    : undefined;
}

export function toolSafety(annotations: ToolAnnotations | undefined): ToolSafety {
  const readOnly = annotations?.readOnlyHint;
  const destructive = annotations?.destructiveHint;
  // Only booleans count: a string "true" from a sloppy upstream is not a declaration.
  if (readOnly === true) return 'readOnly';
  if (destructive === false) return 'additive';
  if (destructive === true || readOnly === false) return 'destructive';
  return 'undeclared';
}

/** "只选只读": exactly the read-only tools of the given scope. */
export const onlyReadOnly = (tools: readonly { id: string; safety: ToolSafety }[]) =>
  tools.filter((tool) => tool.safety === 'readOnly').map((tool) => tool.id);

/**
 * "排除破坏性": the current selection minus every destructive or undeclared tool of the scope.
 * Tools outside the scope keep their state.
 */
export const withoutDestructive = (
  selected: readonly string[],
  tools: readonly { id: string; safety: ToolSafety }[],
) => {
  const risky = new Set(
    tools
      .filter((tool) => tool.safety === 'destructive' || tool.safety === 'undeclared')
      .map((tool) => tool.id),
  );
  return selected.filter((id) => !risky.has(id));
};
