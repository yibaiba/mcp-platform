import { z } from 'zod';
export const embeddingConfig = z
  .object({
    baseUrl: z.url().refine((value) => {
      const url = new URL(value);
      return (
        ['http:', 'https:'].includes(url.protocol) &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash
      );
    }, 'Embedding baseUrl 必须是不含凭证或查询参数的 HTTP(S) 地址'),
    model: z.string().min(1),
    apiKeyRef: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/)
      .optional(),
    dimensions: z.number().int().positive().optional(),
    timeoutMs: z.number().int().positive().default(60_000),
    batchSize: z.number().int().positive().default(64),
  })
  .strict();
export type EmbeddingConfig = z.infer<typeof embeddingConfig>;
