import type { CatalogOptions } from '@platform/contracts';
import { AppError } from '../../shared/errors.js';

type TextOptions = { alias?: string; description?: string };
type ToolOptions = CatalogOptions['tools'][string];

export function mergeTextOptions(current: TextOptions = {}, next: TextOptions): TextOptions {
  for (const field of ['alias', 'description'] as const)
    if (current[field] !== undefined && next[field] !== undefined && current[field] !== next[field])
      throw new AppError('MANIFEST_CATALOG_CONFLICT', `同一能力的 ${field} 配置不一致`, 409);
  return Object.fromEntries(
    ['alias', 'description'].flatMap((key) => {
      const field = key as keyof TextOptions;
      const value = current[field] ?? next[field];
      return value === undefined ? [] : [[field, value]];
    }),
  );
}

export function mergeToolOptions(current: ToolOptions | undefined, next: ToolOptions): ToolOptions {
  return {
    ...mergeTextOptions(current, next),
    hiddenParameters: [
      ...new Set([...(current?.hiddenParameters ?? []), ...next.hiddenParameters]),
    ],
  };
}
