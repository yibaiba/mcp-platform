/**
 * The env / headers key-value editor: validation, masking of stored values and the raw text mode.
 * Stored values never reach the browser; the edit form gets `hiddenValue` in their place and
 * saving it back keeps the stored value (see `restoreHiddenValues`).
 */
export type KeyValueKind = 'env' | 'headers';
export type KeyValueRow = { key: string; value: string };

/** Shown in place of a stored env / header value; saving it back keeps the stored value. */
export const hiddenValue = '[已保存的值，已隐藏]';

const envKey = /^[A-Za-z_][A-Za-z0-9_]*$/;
// RFC 9110 field-name token.
const headerKey = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/** Why a key is not acceptable, or undefined when it is. */
export function keyProblem(kind: KeyValueKind, key: string): string | undefined {
  if (!key) return '名称不能为空';
  if (key !== key.trim()) return '名称前后不能有空格';
  if (kind === 'env' && !envKey.test(key))
    return '环境变量名只能包含字母、数字和下划线，且不能以数字开头';
  if (kind === 'headers' && !headerKey.test(key))
    return '请求头名称只能包含字母、数字和 - 等符号，不能有空格或冒号';
  return undefined;
}

const sensitivePattern =
  /(token|secret|passw|pwd|key|auth|cookie|credential|session|private|signature|bearer)/i;
/** Values of these keys are masked while typing (the user can reveal them). */
export const looksSensitive = (key: string) => sensitivePattern.test(key);

export const rowsFromRecord = (record: Record<string, string> | undefined): KeyValueRow[] =>
  Object.entries(record ?? {}).map(([key, value]) => ({ key, value }));

/**
 * Rows to the stored object. Keys that were loaded from the stored config are accepted as they
 * are even when they would fail validation now, so an existing config saves back unchanged.
 * Fully empty rows are dropped. Returns per-row problems instead of throwing.
 */
export function recordFromRows(
  kind: KeyValueKind,
  rows: readonly KeyValueRow[],
  loadedKeys: ReadonlySet<string> = new Set(),
): { record: Record<string, string>; problems: (string | undefined)[] } {
  const record: Record<string, string> = {};
  const seen = new Map<string, number>();
  const problems = rows.map((row, index) => {
    if (!row.key && !row.value) return undefined;
    const problem = loadedKeys.has(row.key) ? undefined : keyProblem(kind, row.key);
    if (problem) return problem;
    // HTTP header names are case-insensitive; env names are not.
    const identity = kind === 'headers' ? row.key.toLowerCase() : row.key;
    const first = seen.get(identity);
    if (first !== undefined) return `和第 ${first + 1} 行重名`;
    seen.set(identity, index);
    record[row.key] = row.value;
    return undefined;
  });
  return { record, problems };
}

/**
 * The raw mode: a JSON object (`{"KEY": "value"}`), or one entry per line, `KEY=value` for env
 * and `Name: value` for headers. Blank lines and lines starting with # are skipped.
 */
export function parseRawKeyValues(kind: KeyValueKind, text: string): KeyValueRow[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('{')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new Error('以 { 开头，按 JSON 对象解析失败。请检查引号和逗号，或改成每行一项。');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new Error('必须是 JSON 对象，例如 {"API_KEY": "..."}。');
    return Object.entries(parsed).map(([key, value]) => {
      if (typeof value !== 'string') throw new Error(`「${key}」的值必须是字符串。`);
      return { key, value };
    });
  }
  const separator = kind === 'env' ? '=' : ':';
  return trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line, index) => {
      const at = line.indexOf(separator);
      if (at < 1)
        throw new Error(
          `第 ${index + 1} 项缺少「${separator}」：${kind === 'env' ? '写成 KEY=value' : '写成 Name: value'}。`,
        );
      const key = line.slice(0, at).trim();
      const value = line.slice(at + 1);
      return { key, value: kind === 'env' ? value : value.trim() };
    });
}

/** Rows as raw text; JSON keeps every value exactly, including ones with newlines or `=`. */
export const formatRawKeyValues = (rows: readonly KeyValueRow[]) =>
  rows.length
    ? JSON.stringify(Object.fromEntries(rows.map((row) => [row.key, row.value])), null, 2)
    : '';

export const maskValues = (record: Record<string, string> | undefined) =>
  Object.fromEntries(Object.keys(record ?? {}).map((key) => [key, hiddenValue]));

/**
 * Puts stored values back where the form kept the placeholder. A placeholder under a key that was
 * not stored (a renamed or new row) cannot be matched to a value, so it is rejected.
 */
export function restoreHiddenValues(
  label: string,
  previous: Record<string, string> | undefined,
  next: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(next).map(([key, value]) => {
      if (value !== hiddenValue) return [key, value];
      if (previous?.[key] === undefined)
        throw new Error(
          `${label}「${key}」的值是隐藏占位符，但原配置里没有这一项。改了名字的项需要重新填写值。`,
        );
      return [key, previous[key]];
    }),
  );
}
