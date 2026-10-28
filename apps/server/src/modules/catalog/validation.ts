import { isDeepStrictEqual } from 'node:util';
import { and, inArray } from 'drizzle-orm';
import { tools, mcpEntries, type Database } from '@platform/db';
import type { profileInput } from '@platform/contracts';
import type { ShareService } from '../shares/shareService.js';
import { projectTools } from './projection.js';
import { AppError } from '../../shared/errors.js';

export async function validateCatalogOptions(
  deps: {
    db: Database;
    shares: ShareService;
    previous?: import('@platform/contracts').CatalogOptions;
  },
  ownerId: string,
  value: ReturnType<typeof profileInput.parse>,
) {
  const toolIds = [...new Set([...value.toolIds, ...(value.requestable?.toolIds ?? [])])];
  const contentIds = [...new Set([...value.contentIds, ...(value.requestable?.contentIds ?? [])])];
  if (
    Object.keys(value.catalog.tools).some(
      (id) =>
        !toolIds.includes(id) &&
        !isDeepStrictEqual(value.catalog.tools[id], deps.previous?.tools[id]),
    ) ||
    Object.keys(value.catalog.content).some(
      (id) =>
        !contentIds.includes(id) &&
        !isDeepStrictEqual(value.catalog.content[id], deps.previous?.content[id]),
    )
  )
    throw new AppError(
      'CATALOG_UNKNOWN_REFERENCE',
      '目录配置只能引用该 Profile 已选或可申请的能力',
    );
  const selectedTools = toolIds.length
    ? await deps.db
        .select()
        .from(tools)
        .where(
          and(await deps.shares.resourceFilter(ownerId, 'toolIds'), inArray(tools.id, toolIds)),
        )
    : [];
  const selectedContent = contentIds.length
    ? await deps.db
        .select()
        .from(mcpEntries)
        .where(
          and(
            await deps.shares.resourceFilter(ownerId, 'contentIds'),
            inArray(mcpEntries.id, contentIds),
          ),
        )
    : [];
  const connections = new Set(
    [...selectedTools, ...selectedContent].map((row) => row.connectionId),
  );
  if (
    Object.keys(value.catalog.connectionAliases).some(
      (id) =>
        !connections.has(id) &&
        value.catalog.connectionAliases[id] !== deps.previous?.connectionAliases[id],
    )
  )
    throw new AppError(
      'CATALOG_UNKNOWN_REFERENCE',
      '连接展示前缀只能引用该 Profile 已选或可申请的连接',
    );
  projectTools(selectedTools, value.catalog);
}
