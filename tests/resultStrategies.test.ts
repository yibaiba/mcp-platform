import { expect, test } from 'vitest';
import { excerpt } from '../apps/server/src/modules/result-presentation/excerpt.js';
import { selectText } from '../apps/server/src/modules/result-presentation/strategies.js';
import { resultPresentation } from '../packages/contracts/src/resultPresentation.js';
test('JSON samples remain parseable, preserve selected values and obey byte budget', () => {
  const result = selectText(
    JSON.stringify({ big: '中'.repeat(100), small: '值', count: 4 }),
    40,
    'json',
  )!;
  expect(JSON.parse(result.text)).toEqual({ small: '值', count: 4 });
  expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(40);
  expect(result.omitted).toBe(1);
  expect(selectText('[1,2,3]', 1, 'json')!.text).toBe('');
});
test('log prioritizes error context while preserving original line order', () => {
  const lines = [
    'INFO start',
    'INFO idle'.repeat(30),
    'before',
    'ERROR broken',
    'after',
    'INFO end',
  ];
  const result = selectText(lines.join('\n'), 30, 'log')!;
  expect(result.text).toBe('before\nERROR broken\nafter');
  expect(result.omitted).toBe(3);
});
test('search preserves complete file groups and diff preserves complete patches', () => {
  const search = selectText('a.ts:1:first\na.ts:2:second\nb.ts:4:third', 26, 'search')!;
  expect(search.text).toBe('a.ts:1:first\na.ts:2:second');
  expect(search.omitted).toBe(1);
  const patch = 'diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-old\n+new\n';
  const diff = selectText(
    patch + patch.replaceAll('a/a', 'a/b').replaceAll('b/a', 'b/b'),
    Buffer.byteLength(patch),
    'diff',
  )!;
  expect(diff.text).toBe(patch);
  expect(diff.omitted).toBe(1);
});
test('explicit mismatches preserve raw content, auto handles plain text without parsing guesses', () => {
  expect(selectText('not json', 2, 'json')).toMatchObject({
    text: 'not json',
    skipped: expect.any(String),
  });
  expect(selectText('plain text', 2, 'auto')).toBeUndefined();
  expect(selectText('{"a":1}', 2, 'auto')!.strategy).toBe('json');
});
test('multiblock output retains media and structured data and exposes strategies', () => {
  const result = {
    content: [
      { type: 'text' as const, text: JSON.stringify(Array.from({ length: 40 }, (_, i) => i)) },
      { type: 'image' as const, data: 'a', mimeType: 'image/png' },
    ],
    structuredContent: { intact: true },
  };
  const original = structuredClone(result);
  const selected = excerpt(result, { retainBytes: 25, marker: 'original-id', strategy: 'json' });
  expect(selected.retainedBytes).toBeLessThanOrEqual(25);
  expect(selected.strategies).toEqual(['json']);
  expect(selected.result.content[1]).toBe(result.content[1]);
  expect(selected.result.structuredContent).toBe(result.structuredContent);
  expect(result).toEqual(original);
});
test('old configurations retain disabled head-tail behavior and unknown strategies fail', () => {
  expect(resultPresentation.parse({}).enabled).toBe(false);
  const result = { content: [{ type: 'text' as const, text: '中文😀'.repeat(20) }] };
  const options = { retainBytes: 31, marker: 'original' };
  expect(excerpt(result, options)).toEqual(excerpt(result, { ...options, strategy: 'head-tail' }));
  expect(JSON.stringify(excerpt(result, options))).not.toContain('\ufffd');
  expect(() => resultPresentation.parse({ strategy: 'unknown' })).toThrow();
});

test('unsafe JSON numbers are never rounded into a misleading sample', () => {
  const text = '{"identifier":9007199254740993}';
  expect(selectText(text, 8, 'json')).toMatchObject({ text, skipped: expect.any(String) });
  expect(selectText(text, 8, 'auto')).toBeUndefined();
});
