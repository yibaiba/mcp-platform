import { ExecutionBudget } from './executionBudget.js';
import type { McpRequestOptions } from './operations.js';

export async function withRequestBudget<T>(input: {
  policy: ConstructorParameters<typeof ExecutionBudget>[0];
  options?: McpRequestOptions;
  execute: (options: McpRequestOptions) => Promise<T>;
}) {
  const { options = {} } = input;
  if (options.executionTimeoutMs !== undefined) return input.execute(options);
  const budget = new ExecutionBudget(input.policy);
  budget.resume();
  try {
    return await input.execute({
      ...options,
      executionTimeoutMs: budget.remainingMs,
      signal: AbortSignal.any([budget.signal, ...(options.signal ? [options.signal] : [])]),
      onprogress: (progress) => {
        budget.progress(progress);
        options.onprogress?.(progress);
      },
    });
  } finally {
    budget.pause();
  }
}
