import { expect, test } from 'vitest';
import {
  formatRawKeyValues,
  hiddenValue,
  keyProblem,
  onlyReadOnly,
  parseRawKeyValues,
  recordFromRows,
  restoreHiddenValues,
  toolAnnotations,
  toolSafety,
  withoutDestructive,
} from '../packages/contracts/src/index.js';

test('annotations map to read-only, additive, destructive or undeclared', () => {
  expect(toolSafety({ readOnlyHint: true })).toBe('readOnly');
  // readOnly wins: destructiveHint only means something for tools that are not read-only.
  expect(toolSafety({ readOnlyHint: true, destructiveHint: true })).toBe('readOnly');
  expect(toolSafety({ destructiveHint: false })).toBe('additive');
  expect(toolSafety({ readOnlyHint: false, destructiveHint: false })).toBe('additive');
  expect(toolSafety({ destructiveHint: true })).toBe('destructive');
  // MCP default for a tool that is not read-only and says nothing more: destructive.
  expect(toolSafety({ readOnlyHint: false })).toBe('destructive');
  expect(toolSafety(undefined)).toBe('undeclared');
  expect(toolSafety({})).toBe('undeclared');
  expect(toolSafety({ idempotentHint: true, openWorldHint: false })).toBe('undeclared');
  // Only booleans count.
  expect(toolSafety({ readOnlyHint: 'true', destructiveHint: 'false' })).toBe('undeclared');
  expect(toolAnnotations({ annotations: { readOnlyHint: true } })).toEqual({ readOnlyHint: true });
  expect(toolAnnotations({ annotations: [] })).toBeUndefined();
  expect(toolAnnotations(null)).toBeUndefined();
});

test('bulk actions treat undeclared tools as possibly destructive and keep tools outside scope', () => {
  const scope = [
    { id: 'read', safety: 'readOnly' as const },
    { id: 'add', safety: 'additive' as const },
    { id: 'drop', safety: 'destructive' as const },
    { id: 'unknown', safety: 'undeclared' as const },
  ];
  expect(onlyReadOnly(scope)).toEqual(['read']);
  expect(withoutDestructive(['read', 'add', 'drop', 'unknown', 'other'], scope)).toEqual([
    'read',
    'add',
    'other',
  ]);
  expect(withoutDestructive([], scope)).toEqual([]);
});

test('key validation: env names, header tokens, duplicates and keys loaded from the stored config', () => {
  expect(keyProblem('env', 'API_KEY')).toBeUndefined();
  expect(keyProblem('env', '_x1')).toBeUndefined();
  expect(keyProblem('env', '1ABC')).toMatch('不能以数字开头');
  expect(keyProblem('env', 'A-B')).toMatch('只能包含');
  expect(keyProblem('env', '')).toMatch('不能为空');
  expect(keyProblem('env', ' A')).toMatch('前后不能有空格');
  expect(keyProblem('headers', 'X-Api-Key')).toBeUndefined();
  expect(keyProblem('headers', 'Bad Header')).toMatch('不能有空格');
  expect(keyProblem('headers', 'A:B')).toMatch('冒号');

  const headers = recordFromRows('headers', [
    { key: 'Authorization', value: 'a' },
    { key: 'authorization', value: 'b' },
    { key: '', value: '' },
    { key: 'X-Ok', value: '' },
  ]);
  expect(headers.problems).toEqual([undefined, '和第 1 行重名', undefined, undefined]);
  expect(headers.record).toEqual({ Authorization: 'a', 'X-Ok': '' });
  // env names are case-sensitive.
  expect(
    recordFromRows('env', [
      { key: 'a', value: '1' },
      { key: 'A', value: '2' },
    ]).record,
  ).toEqual({ a: '1', A: '2' });
  // A key that is already stored saves back unchanged even if it would fail validation now.
  expect(
    recordFromRows('env', [{ key: 'legacy-key', value: hiddenValue }], new Set(['legacy-key'])),
  ).toEqual({ record: { 'legacy-key': hiddenValue }, problems: [undefined] });
  expect(recordFromRows('env', [{ key: 'new-key', value: 'x' }]).problems[0]).toMatch('只能包含');
});

test('raw mode reads JSON or one entry per line and round-trips values exactly', () => {
  expect(parseRawKeyValues('env', '{"A":"1","B":"x=y\\nz"}')).toEqual([
    { key: 'A', value: '1' },
    { key: 'B', value: 'x=y\nz' },
  ]);
  expect(parseRawKeyValues('env', '# comment\nA=1\n\nB= spaced = kept ')).toEqual([
    { key: 'A', value: '1' },
    { key: 'B', value: ' spaced = kept' },
  ]);
  expect(parseRawKeyValues('headers', 'Authorization: Bearer t\nX-A:b')).toEqual([
    { key: 'Authorization', value: 'Bearer t' },
    { key: 'X-A', value: 'b' },
  ]);
  expect(parseRawKeyValues('env', '   ')).toEqual([]);
  expect(() => parseRawKeyValues('env', '{"A":')).toThrow('JSON 对象解析失败');
  expect(() => parseRawKeyValues('env', '{"A":1}')).toThrow('必须是字符串');
  expect(() => parseRawKeyValues('env', 'NOVALUE')).toThrow('KEY=value');
  expect(() => parseRawKeyValues('headers', 'Name value')).toThrow('Name: value');
  const rows = [
    { key: 'A', value: 'line\nbreak' },
    { key: 'B', value: hiddenValue },
  ];
  expect(parseRawKeyValues('env', formatRawKeyValues(rows))).toEqual(rows);
  expect(formatRawKeyValues([])).toBe('');
});

test('placeholders restore stored values; a placeholder under a new key is rejected', () => {
  const stored = { TOKEN: 'secret', MODE: 'x' };
  expect(restoreHiddenValues('环境变量', stored, { TOKEN: hiddenValue, MODE: 'y' })).toEqual({
    TOKEN: 'secret',
    MODE: 'y',
  });
  expect(() => restoreHiddenValues('环境变量', stored, { RENAMED: hiddenValue })).toThrow(
    '改了名字的项需要重新填写值',
  );
  expect(() => restoreHiddenValues('请求头', undefined, { A: hiddenValue })).toThrow('请求头「A」');
});
