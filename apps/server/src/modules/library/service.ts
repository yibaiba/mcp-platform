import { removeConnectionReferences } from '../mcp/removeReferences.js';
import { and, eq } from 'drizzle-orm';
import { connections, libraryEntries, type Database } from '@platform/db';
import {
  libraryItem,
  renderPrompt,
  type ConnectionInput,
  type LibraryItem,
} from '@platform/contracts';
import { z } from 'zod';
import type { Vault } from '../../shared/crypto.js';
import { AppError } from '../../shared/errors.js';
import type { ConnectionService } from '../mcp/connectionService.js';
import { digest } from '../../shared/crypto.js';
export class LibraryService {
  constructor(
    private readonly deps: {
      db: Database;
      vault: Vault;
      connections: ConnectionService;
      changed: (ownerId: string, contentId: string, profileIds?: string[]) => Promise<void>;
    },
  ) {}
  async list(ownerId: string, kind: LibraryItem['kind']) {
    const rows = await this.deps.db
      .select({ row: connections })
      .from(libraryEntries)
      .innerJoin(connections, eq(connections.id, libraryEntries.connectionId))
      .where(and(eq(libraryEntries.ownerId, ownerId), eq(libraryEntries.kind, kind)));
    return rows.map(({ row }) => this.present(row));
  }
  private present(row: typeof connections.$inferSelect) {
    const config = this.deps.vault.open<ConnectionInput>(row.config, `${row.ownerId}:${row.id}`);
    const item = libraryItem.parse(config.library);
    return {
      ...item,
      id: row.id,
      revision: row.revision,
      contentId: `${item.kind}_${digest(`${row.id}:library`)}`,
    };
  }
  async get(ownerId: string, input: { id: string; kind: LibraryItem['kind'] }) {
    const row = await this.deps.connections.owned(ownerId, input.id);
    const config = this.deps.vault.open<ConnectionInput>(row.config, `${ownerId}:${input.id}`);
    if (config.source !== 'library' || config.library?.kind !== input.kind)
      throw new AppError('NOT_FOUND', '内容不存在', 404);
    return this.present(row);
  }
  async save(ownerId: string, input: { kind: LibraryItem['kind']; id?: string; value: unknown }) {
    const { revision, ...raw } = z
      .object({ revision: z.number().int().positive().optional() })
      .passthrough()
      .parse(input.value);
    const item = libraryItem.parse({ ...raw, kind: input.kind });
    if (input.id) {
      await this.get(ownerId, { id: input.id, kind: input.kind });
      if (revision === undefined)
        throw new AppError('REVISION_REQUIRED', '编辑需要当前修订号', 409);
    }
    const config = {
      name: `内容库 ${item.kind} ${item.name.replace(/[^\p{L}\p{N}. @-]/gu, (c) => `_${c.codePointAt(0)!.toString(16)}_`)}`,
      source: 'library',
      library: item,
      adapter: 'direct',
      mode: 'existing',
      transport: 'http',
    };
    const row = input.id
      ? await this.deps.connections.update(ownerId, input.id, { ...config, revision })
      : await this.deps.connections.create(ownerId, config);
    await this.deps.connections.discover(ownerId, row.id);
    const result = await this.get(ownerId, { id: row.id, kind: input.kind });
    await this.deps.changed(ownerId, result.contentId);
    return result;
  }
  async remove(
    ownerId: string,
    input: { id: string; kind: LibraryItem['kind']; revision: number },
  ) {
    const previous = await this.get(ownerId, input);
    if (previous.revision !== input.revision)
      throw new AppError('REVISION_CONFLICT', '内容已改变，请重新加载', 409);
    await this.deps.connections.close(ownerId, input.id);
    // Compare and delete atomically; a concurrent edit must not be silently deleted.
    const affected = await this.deps.db.transaction(async (tx) => {
      const deleted = await tx
        .delete(connections)
        .where(
          and(
            eq(connections.ownerId, ownerId),
            eq(connections.id, input.id),
            eq(connections.revision, input.revision),
          ),
        )
        .returning();
      if (!deleted.length) throw new AppError('REVISION_CONFLICT', '内容已改变，请重新加载', 409);
      return removeConnectionReferences(tx, {
        connectionId: input.id,
        contentIds: [previous.contentId],
        toolIds: [],
      });
    });
    await this.deps.changed(ownerId, previous.contentId, affected);
  }
  preview(value: unknown) {
    const input = z
      .object({ item: libraryItem, arguments: z.record(z.string(), z.string()).default({}) })
      .strict()
      .parse(value);
    if (input.item.kind !== 'prompt') throw new AppError('PROMPT_REQUIRED', '只能预览 Prompt');
    try {
      return { text: renderPrompt(input.item, input.arguments) };
    } catch (cause) {
      throw new AppError('PROMPT_ARGUMENTS', (cause as Error).message);
    }
  }
}
