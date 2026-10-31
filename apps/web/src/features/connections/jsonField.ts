/** Optional JSON-object fields (advanced/developer options) with a readable error. */
export function parseJsonObject(text: string, label: string): Record<string, unknown> {
  if (!text.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${label}不是有效的 JSON：请检查引号、逗号和括号，或清空这一栏。`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error(`${label}必须是 JSON 对象，例如 {"env": {}}。`);
  return parsed as Record<string, unknown>;
}
