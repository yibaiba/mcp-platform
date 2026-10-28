import { afterEach, expect, test, vi } from 'vitest';
import { ExecutionBudget } from '../packages/mcp/src/executionBudget.js';
import { connectionInput } from '../packages/contracts/src/index.js';

afterEach(() => vi.useRealTimers());
const policy = { timeoutMs: 100, resetTimeoutOnProgress: true, maxTotalTimeoutMs: 250 };
function budget() {
  vi.useFakeTimers();
  return new ExecutionBudget(policy, {
    now: () => Date.now(),
    schedule: (callback, delay) => setTimeout(callback, delay),
    clear: (timer) => clearTimeout(timer),
  });
}
test('progress renews idle time but cannot extend total execution', async () => {
  const execution = budget();
  execution.resume();
  for (const progress of [0, 1, 2]) {
    await vi.advanceTimersByTimeAsync(80);
    execution.progress({ progress });
    expect(execution.signal.aborted).toBe(false);
  }
  await vi.advanceTimersByTimeAsync(10);
  expect(execution.signal.aborted).toBe(true);
});
test('waiting for answers consumes no execution time and continuations share the total', async () => {
  const execution = budget();
  execution.resume();
  await vi.advanceTimersByTimeAsync(80);
  execution.pause();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(execution.remainingMs).toBe(170);
  execution.resume();
  await vi.advanceTimersByTimeAsync(80);
  execution.progress({ progress: 1 });
  execution.pause();
  expect(execution.remainingMs).toBe(90);
  execution.resume();
  await vi.advanceTimersByTimeAsync(90);
  expect(execution.signal.aborted).toBe(true);
});
test('repeated, regressing and invalid progress cannot keep a call alive', async () => {
  const execution = budget();
  execution.resume();
  execution.progress({ progress: 1 });
  await vi.advanceTimersByTimeAsync(80);
  for (const progress of [1, 0, -1, NaN, Infinity]) execution.progress({ progress });
  execution.progress({ progress: 2, total: 1 });
  await vi.advanceTimersByTimeAsync(20);
  expect(execution.signal.aborted).toBe(true);
});
test('old connection configuration defaults to 60 seconds without renewal', () => {
  const input = {
    name: 'test',
    adapter: 'direct',
    transport: 'http',
    mode: 'existing',
    url: 'http://localhost/mcp',
  };
  const parsed = connectionInput.parse(input);
  expect(parsed.connectTimeoutMs).toBe(60_000);
  expect(parsed.requestOptions).toEqual({ timeoutMs: 60_000, resetTimeoutOnProgress: false });
  for (const requestOptions of [
    { resetTimeoutOnProgress: true },
    { timeoutMs: 100, maxTotalTimeoutMs: 99 },
    { timeoutMs: 0 },
  ])
    expect(connectionInput.safeParse({ ...input, requestOptions }).success).toBe(false);
});
