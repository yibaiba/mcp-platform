import { z } from 'zod';
export const resultPresentation = z
  .object({
    enabled: z.boolean().default(false),
    thresholdBytes: z
      .number()
      .int()
      .positive()
      .default(32 * 1024),
    retainBytes: z
      .number()
      .int()
      .positive()
      .default(8 * 1024),
  })
  .strict()
  .refine((value) => value.retainBytes <= value.thresholdBytes, '保留字节数不能大于触发阈值');
export type ResultPresentation = z.infer<typeof resultPresentation>;
