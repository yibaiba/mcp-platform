import { selectText } from './strategies.js';
import type { ResultPresentation } from '@platform/contracts';
import type { CallToolResult } from '@platform/mcp';
export function textBytes(result: CallToolResult) {
  return result.content.reduce(
    (sum, block) => sum + (block.type === 'text' ? Buffer.byteLength(block.text, 'utf8') : 0),
    0,
  );
}
function headTail(text: string, budget: number) {
  const bytes = Buffer.from(text, 'utf8');
  let headEnd = Math.floor(budget / 2),
    tailStart = bytes.length - (budget - headEnd);
  while (headEnd > 0 && (bytes[headEnd]! & 0xc0) === 0x80) headEnd--;
  while (tailStart < bytes.length && (bytes[tailStart]! & 0xc0) === 0x80) tailStart++;
  return {
    head: bytes.subarray(0, headEnd).toString('utf8'),
    tail: bytes.subarray(tailStart).toString('utf8'),
    omitted: tailStart - headEnd,
    retained: headEnd + bytes.length - tailStart,
  };
}
export function excerpt(
  result: CallToolResult,
  input: { retainBytes: number; marker: string; strategy?: ResultPresentation['strategy'] },
) {
  const lengths = result.content.map((block) =>
    block.type === 'text' ? Buffer.byteLength(block.text, 'utf8') : 0,
  );
  const total = lengths.reduce((sum, length) => sum + length, 0);
  if (total <= input.retainBytes)
    return { result, retainedBytes: total, strategies: [] as string[] };
  const budgets = lengths.map((length) => Math.floor((input.retainBytes * length) / total));
  const remaining = input.retainBytes - budgets.reduce((sum, budget) => sum + budget, 0);
  const byRemainder = lengths
    .map((length, index) => ({ index, remainder: (input.retainBytes * length) % total }))
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  for (const { index } of byRemainder.slice(0, remaining)) budgets[index] = budgets[index]! + 1;
  let retainedBytes = 0;
  const strategies: string[] = [];
  const content = result.content.map((block, index) => {
    if (block.type !== 'text') return block;
    if (lengths[index]! <= budgets[index]!) {
      retainedBytes += lengths[index]!;
      return block;
    }
    const selected = selectText(block.text, budgets[index]!, input.strategy ?? 'head-tail');
    if (selected) {
      retainedBytes += Buffer.byteLength(selected.text);
      strategies.push(selected.strategy);
      const detail = selected.skipped ?? `省略 ${selected.omitted} ${selected.unit}`;
      return {
        ...block,
        text: `${selected.text}\n[明确节选：策略 ${selected.strategy}；${detail}。${input.marker}]`,
      };
    }
    strategies.push(input.strategy === 'auto' ? 'text' : (input.strategy ?? 'head-tail'));
    const sliced = headTail(block.text, budgets[index]!);
    retainedBytes += sliced.retained;
    return {
      ...block,
      text: `${sliced.head}\n[明确节选：省略 ${sliced.omitted} 字节。${input.marker}]\n${sliced.tail}`,
    };
  });
  return { result: { ...result, content }, retainedBytes, strategies };
}
