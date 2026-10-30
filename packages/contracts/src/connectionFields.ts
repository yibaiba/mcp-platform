/** Shown in place of a sensitive argument; saving it back keeps the stored value. */
export const hiddenArgument = '[已隐藏的敏感参数]';

/**
 * Parses the "one argument per line" field. A pasted JSON array is accepted too, so existing
 * `["-y","pkg"]` snippets keep working. Errors are written for the person filling the form.
 */
export function parseArgumentLines(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new Error(
        '参数以 [ 开头，按 JSON 数组解析失败。请检查引号和逗号，或改成每行填一个参数。',
      );
    }
    if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string'))
      throw new Error('JSON 数组里的每个参数都必须是字符串，例如 ["-y", "some-package"]。');
    return parsed as string[];
  }
  return trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export const formatArgumentLines = (args: readonly string[]) => args.join('\n');

/**
 * Puts stored secrets back where the form kept the placeholder. A placeholder that moved to
 * another line cannot be matched to its secret, so it is rejected instead of being saved as text.
 */
export function restoreHiddenArguments(
  previous: { args: readonly string[]; sensitiveArguments?: readonly number[] },
  next: readonly string[],
): string[] {
  const sensitive = new Set(previous.sensitiveArguments ?? []);
  return next.map((arg, index) => {
    if (arg !== hiddenArgument) return arg;
    if (!sensitive.has(index) || previous.args[index] === undefined)
      throw new Error(
        `第 ${index + 1} 行的「${hiddenArgument}」位置变了。敏感参数需要留在原来的行，或在这一行重新填写真实值。`,
      );
    return previous.args[index]!;
  });
}

/** Arguments as the edit form shows them: sensitive ones are replaced by the placeholder. */
export const maskArguments = (args: readonly string[], sensitive: readonly number[] = []) =>
  args.map((arg, index) => (sensitive.includes(index) ? hiddenArgument : arg));
