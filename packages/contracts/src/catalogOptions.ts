import { z } from 'zod';
const name = z.string().regex(/^[A-Za-z0-9_.-]+$/, '名称只允许字母、数字、下划线、点和连字符');
export const catalogOptions = z
  .object({
    toolNaming: z.enum(['stable', 'original', 'prefixed']).default('stable'),
    connectionAliases: z.record(z.uuid(), name).default({}),
    tools: z
      .record(
        z.string().min(1),
        z
          .object({
            alias: name.optional(),
            description: z.string().optional(),
            hiddenParameters: z.array(z.string().min(1)).default([]),
          })
          .strict(),
      )
      .default({}),
    content: z
      .record(z.string().min(1), z.object({ description: z.string().optional() }).strict())
      .default({}),
  })
  .strict();
export type CatalogOptions = z.infer<typeof catalogOptions>;
