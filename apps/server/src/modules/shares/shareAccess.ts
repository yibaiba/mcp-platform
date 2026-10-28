import { and, eq, inArray, or } from 'drizzle-orm';
import {
  artifacts,
  connectionShares,
  connections,
  mcpEntries,
  tools,
  user,
  type Database,
} from '@platform/db';
import type { PermissionKind } from '../permissions/accessService.js';
import { AppError } from '../../shared/errors.js';
import { activeUser } from '../users/userAccess.js';

export class ShareAccess {
  constructor(protected readonly db: Database) {}
  async grants(recipientId: string) {
    return this.db
      .select({ grant: connectionShares })
      .from(connectionShares)
      .innerJoin(user, eq(user.id, connectionShares.ownerId))
      .where(
        and(
          eq(connectionShares.recipientId, recipientId),
          eq(connectionShares.revoked, false),
          eq(user.enabled, true),
        ),
      )
      .then((rows) => rows.map(({ grant }) => grant));
  }
  async resourceFilter(ownerId: string, kind: PermissionKind) {
    const table = kind === 'toolIds' ? tools : kind === 'contentIds' ? mcpEntries : artifacts;
    if (kind === 'artifactIds') return eq(table.ownerId, ownerId);
    const ids = (await this.grants(ownerId)).flatMap((grant) => grant[kind]);
    return or(eq(table.ownerId, ownerId), ids.length ? inArray(table.id, ids) : undefined)!;
  }
  async permitted(ownerId: string, kind: PermissionKind, ids: string[]) {
    if (!ids.length) return [];
    const table = kind === 'toolIds' ? tools : kind === 'contentIds' ? mcpEntries : artifacts;
    const rows = await this.db
      .select({ id: table.id })
      .from(table)
      .where(and(await this.resourceFilter(ownerId, kind), inArray(table.id, ids)));
    return rows.map((row) => row.id);
  }
  async connection(ownerId: string, id: string) {
    await activeUser(this.db, ownerId);
    const [connection] = await this.db.select().from(connections).where(eq(connections.id, id));
    if (!connection) throw new AppError('NOT_FOUND', '连接不存在', 404);
    if (connection.ownerId === ownerId) return { connection, share: undefined };
    const share = (await this.grants(ownerId)).find((grant) => grant.connectionId === id);
    if (!share) throw new AppError('NOT_FOUND', '连接不存在或共享授权已撤销', 404);
    return { connection, share };
  }
}
