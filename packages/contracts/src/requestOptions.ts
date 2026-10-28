import { z } from 'zod';

export const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
export const requestOptions = z
  .object({
    timeoutMs: z.number().int().positive().default(DEFAULT_REQUEST_TIMEOUT_MS),
    resetTimeoutOnProgress: z.boolean().default(false),
    maxTotalTimeoutMs: z.number().int().positive().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.resetTimeoutOnProgress && value.maxTotalTimeoutMs === undefined)
      context.addIssue({ code: 'custom', message: '进度续期必须设置最长总执行时间' });
    if (value.maxTotalTimeoutMs !== undefined && value.maxTotalTimeoutMs < value.timeoutMs)
      context.addIssue({ code: 'custom', message: '最长总执行时间不能小于单次等待时间' });
  });
export type RequestOptions = z.infer<typeof requestOptions>;
