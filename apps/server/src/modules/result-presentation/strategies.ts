import type { ResultPresentation } from '@platform/contracts';
import { jsonNumberRoundtrips } from './jsonNumbers.js';
type Strategy = NonNullable<ResultPresentation['strategy']>;
export type Selection = {
  text: string;
  strategy: Strategy;
  omitted: number;
  unit: string;
  skipped?: string;
};
const errorLine = /\b(ERROR|FAIL(?:ED)?|FATAL|CRITICAL|WARN(?:ING)?)\b|Traceback|^\s+at /i;
const searchLine = /^(.+?):\d+(?::\d+)?:/;
function jsonValue(text: string): unknown {
  try {
    return JSON.parse(text, (_key, value: unknown, context?: { source?: string }) => {
      // The reviver's source retains decimals that JSON.parse has already rounded.
      if (
        typeof value === 'number' &&
        (!context?.source || !jsonNumberRoundtrips(value, context.source))
      )
        throw new Error('JSON number cannot be sampled without precision loss');
      return value;
    });
  } catch {
    return undefined;
  }
}
function searchLines(text: string) {
  const lines = text.split('\n');
  // A terminal line ending does not introduce an additional search result.
  if (text.endsWith('\n')) lines.pop();
  return lines;
}
function detect(text: string): Exclude<Strategy, 'auto'> {
  const parsed = jsonValue(text);
  if (parsed !== null && typeof parsed === 'object') return 'json';
  if (/^diff --git /m.test(text)) return 'diff';
  const lines = searchLines(text);
  if (lines.every((line) => searchLine.test(line))) return 'search';
  if (lines.some((line) => errorLine.test(line))) return 'log';
  return 'text';
}
function jsonSample(text: string, budget: number): Selection {
  const value = jsonValue(text);
  if (value === null || typeof value !== 'object') return skipped(text, 'json');
  const array = Array.isArray(value);
  const entries = Object.entries(value);
  const kept: [string, unknown][] = [];
  let bytes = 2;
  for (const entry of entries) {
    const item =
      JSON.stringify(array ? entry[1] : entry[0]) + (array ? '' : ':' + JSON.stringify(entry[1]));
    const size = Buffer.byteLength(item) + (kept.length ? 1 : 0);
    if (bytes + size > budget) continue;
    kept.push(entry);
    bytes += size;
  }
  if (budget < 2) return { text: '', strategy: 'json', omitted: entries.length, unit: '项' };
  return {
    text: JSON.stringify(array ? kept.map((entry) => entry[1]) : Object.fromEntries(kept)),
    strategy: 'json',
    omitted: entries.length - kept.length,
    unit: '项',
  };
}
function skipped(text: string, strategy: Strategy): Selection {
  return { text, strategy, omitted: 0, unit: '行', skipped: '内容与指定策略不匹配，保留原文' };
}
function selectGroups(groups: string[], budget: number) {
  const selected: string[] = [];
  let bytes = 0;
  for (const group of groups) {
    const size = Buffer.byteLength(group) + (selected.length ? 1 : 0);
    if (bytes + size > budget) continue;
    selected.push(group);
    bytes += size;
  }
  return selected;
}
function logSample(text: string, budget: number): Selection {
  const lines = text.split('\n');
  const priority = new Set<number>(
    lines.flatMap((line, index) => (errorLine.test(line) ? [index] : [])),
  );
  lines.forEach((line, index) => {
    if (!errorLine.test(line)) return;
    for (let i = Math.max(0, index - 1); i <= Math.min(lines.length - 1, index + 1); i++)
      priority.add(i);
  });
  if (!priority.size) return skipped(text, 'log');
  const order = [...priority, ...lines.map((_, i) => i).filter((i) => !priority.has(i))];
  const selected: number[] = [];
  let bytes = 0;
  for (const index of order) {
    const size = Buffer.byteLength(lines[index]!) + (selected.length ? 1 : 0);
    if (bytes + size > budget) continue;
    selected.push(index);
    bytes += size;
  }
  return {
    text: selected
      .sort((a, b) => a - b)
      .map((i) => lines[i])
      .join('\n'),
    strategy: 'log',
    omitted: lines.length - selected.length,
    unit: '行',
  };
}
function groupedSample(text: string, budget: number, strategy: 'search' | 'diff'): Selection {
  if (strategy === 'diff') {
    if (!/^diff --git /m.test(text)) return skipped(text, strategy);
    const groups = text
      .split(/(?=^diff --git )/m)
      .filter(Boolean)
      .flatMap((file) => {
        const [header, ...hunks] = file.split(/(?=^@@ )/m);
        return hunks.length ? hunks.map((hunk) => header + hunk) : [file];
      });
    const selected = selectGroups(groups, budget);
    return {
      text: selected.join('\n'),
      strategy,
      omitted: groups.length - selected.length,
      unit: '文件修改块',
    };
  }
  const groups = new Map<string, string[]>();
  for (const line of searchLines(text)) {
    const match = searchLine.exec(line);
    if (!match) return skipped(text, strategy);
    const group = groups.get(match[1]!) ?? [];
    group.push(line);
    groups.set(match[1]!, group);
  }
  const selected = selectGroups(
    [...groups.values()].map((group) => group.join('\n')),
    budget,
  );
  return {
    text: selected.join('\n'),
    strategy,
    omitted: groups.size - selected.length,
    unit: '文件组',
  };
}
export function selectText(
  text: string,
  budget: number,
  requested: Strategy,
): Selection | undefined {
  const strategy = requested === 'auto' ? detect(text) : requested;
  if (strategy === 'head-tail' || strategy === 'text') return undefined;
  if (strategy === 'json') return jsonSample(text, budget);
  if (strategy === 'log') return logSample(text, budget);
  return groupedSample(text, budget, strategy);
}
