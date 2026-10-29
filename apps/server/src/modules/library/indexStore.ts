import { eq } from 'drizzle-orm';
import { libraryEntries, type Database } from '@platform/db';
import type { ConnectionInput } from '@platform/contracts';
import { AppError } from '../../shared/errors.js';
type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
export async function indexLibrary(
  tx: Transaction,
  row: { id: string; ownerId: string; config: ConnectionInput },
) {
  const item = row.config.source === 'library' ? row.config.library : undefined;
  if (!item) {
    await tx.delete(libraryEntries).where(eq(libraryEntries.connectionId, row.id));
    return;
  }
  const fields = {
    ownerId: row.ownerId,
    kind: item.kind,
    name: item.name,
    locator: item.kind === 'prompt' ? item.name : item.uri,
  };
  await tx
    .insert(libraryEntries)
    .values({ connectionId: row.id, ...fields })
    .onConflictDoUpdate({ target: libraryEntries.connectionId, set: fields });
}
export function libraryConflict(error: unknown): never {
  const root = error as {
    code?: string;
    constraint?: string;
    cause?: { code?: string; constraint?: string };
  };
  const pg = root.cause ?? root;
  if (pg.code === '23505' && pg.constraint?.startsWith('library_owner_'))
    throw new AppError('LIBRARY_CONFLICT', '内容名称或资源 URI 已存在', 409);
  throw error;
}
