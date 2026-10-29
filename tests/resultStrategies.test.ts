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

test.each(['0.123456789012345678901', '1e-400', '1e400', '-0', '9007199254740992.1'])(
  'JSON sampling preserves the original when %s cannot roundtrip',
  (number) => {
    const text = `{"nested":[{"value":${number}}],"padding":"${'x'.repeat(100)}"}`;
    expect(selectText(text, 50, 'json')).toMatchObject({ text, skipped: expect.any(String) });
    expect(selectText(text, 50, 'auto')).toBeUndefined();
  },
);

test.each(['0.1250', '1.25e-1', '123e+2', '-0.5', '5e-324', '0e9999'])(
  'JSON sampling accepts equivalent decimal spellings of %s',
  (number) => {
    const text = `{"value":${number},"padding":"${'x'.repeat(100)}"}`;
    const selected = selectText(text, 30, 'json')!;
    expect(selected.skipped).toBeUndefined();
    expect(JSON.parse(selected.text)).toEqual({ value: Number(number) });
    expect(selected.omitted).toBe(1);
  },
);

test.each(['\n', '\r\n'])(
  'search and auto recognize a terminal %j without exceeding the retained budget',
  (newline) => {
    const text = ['a.ts:1:first', 'a.ts:2:second', 'b.ts:4:third'].join(newline) + newline;
    const budget = 30;
    for (const strategy of ['search', 'auto'] as const) {
      const selected = selectText(text, budget, strategy)!;
      expect(selected).toMatchObject({ strategy: 'search', omitted: 1 });
      expect(selected.skipped).toBeUndefined();
      expect(selected.text).toContain('a.ts:1:first');
      expect(selected.text).toContain('a.ts:2:second');
      expect(selected.text).not.toContain('b.ts');
      const result = excerpt(
        { content: [{ type: 'text', text }] },
        {
          strategy,
          retainBytes: budget,
          marker: 'original-id',
        },
      );
      expect(result.retainedBytes).toBeLessThanOrEqual(budget);
      expect(result.strategies).toEqual(['search']);
    }
  },
);

test('search still rejects interior blank lines and non-search text', () => {
  for (const text of ['a.ts:1:first\n\nb.ts:2:second\n', 'a.ts:1:first\nfooter\n'])
    expect(selectText(text, 10, 'search')).toMatchObject({ text, skipped: expect.any(String) });
});
