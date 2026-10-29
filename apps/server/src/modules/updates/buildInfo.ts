import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
export const buildInfoSchema = z
  .object({
    version: z.string(),
    commit: z.string(),
    builtAt: z.string().nullable(),
    release: z.boolean(),
  })
  .strict();
export type BuildInfo = z.infer<typeof buildInfoSchema>;
export function readBuildInfo(root: string): BuildInfo {
  try {
    return buildInfoSchema.parse(JSON.parse(readFileSync(join(root, '.build-info.json'), 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    // Unbuilt source checkout: state what is unknown rather than claiming a release version.
    return { version: 'dev', commit: 'unknown', builtAt: null, release: false };
  }
}
