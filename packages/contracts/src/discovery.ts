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

export const searchOptions = z
  .object({
    strategy: z.enum(['exact', 'hnsw']).default('exact'),
    minScore: z.number().finite().min(-1).max(1).nullable().default(null),
    hnsw: z
      .object({
        m: z.number().int().min(2).max(100).default(16),
        efConstruction: z.number().int().min(4).max(1000).default(64),
        efSearch: z.number().int().min(1).max(1000).default(100),
      })
      .strict()
      .default({ m: 16, efConstruction: 64, efSearch: 100 }),
  })
  .strict()
  .refine((value) => value.hnsw.efConstruction >= 2 * value.hnsw.m, {
    message: 'efConstruction 必须至少为 m 的两倍',
    path: ['hnsw', 'efConstruction'],
  });
export type SearchOptions = z.infer<typeof searchOptions>;
// Persisted profiles and old manifests deliberately retain unfiltered retrieval.
export const newSearchOptions = () => searchOptions.parse({ minScore: 0.3 });
