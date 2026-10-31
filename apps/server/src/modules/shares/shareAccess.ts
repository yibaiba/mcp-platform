import { and, eq, inArray, or, sql } from 'drizzle-orm';
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
  /**
   * Gives `recipientId` its copy of every active team grant it does not have a row for yet
   * (accounts created or re-enabled after the team grant). Existing rows win: a direct grant,
   * or an exclusion (revoked team copy), is never overwritten here.
   */
  async joinTeamShares(recipientId: string) {
    await this.db.execute(sql`
      insert into "connection_shares"
        ("connection_id", "owner_id", "recipient_id", "credential_mode", "tool_ids", "content_ids", "team_share_id")
      select t."connection_id", t."owner_id", u."id", t."credential_mode", t."tool_ids", t."content_ids", t."id"
      from "connection_team_shares" t
      join "user" u on u."id" = ${recipientId} and u."enabled" = true
      where t."revoked" = false and t."owner_id" <> ${recipientId}
      on conflict ("connection_id", "recipient_id") do nothing`);
  }
  async grants(recipientId: string) {
    await this.joinTeamShares(recipientId);
    return this.db
      .select({ grant: connectionShares })
      .from(connectionShares)
      .innerJoin(user, eq(user.id, connectionShares.ownerId))
      .where(
        and(
          eq(connectionShares.recipientId, recipientId),
          eq(connectionShares.revoked, false),
          eq(user.enabled, true),
          // Disabled recipients are not share audiences (direct or team).
          sql`exists (select 1 from "user" r where r."id" = ${connectionShares.recipientId} and r."enabled" = true)`,
        ),
      )
      .then((rows) => rows.map(({ grant }) => grant));
  }
  async resourceFilter(ownerId: string, kind: PermissionKind) {
    const table = kind === 'toolIds' ? tools : kind === 'contentIds' ? mcpEntries : artifacts;
    if (kind === 'artifactIds') return eq(table.ownerId, ownerId);
    const ids = (await this.grants(ownerId)).flatMap((grant) => grant[kind]);
    return or(
      eq(table.ownerId, ownerId),
      ids.length ? sql`${table.id} = any(${sql.param(ids)}::text[])` : undefined,
    )!;
  }
  async permitted(ownerId: string, kind: PermissionKind, ids: string[]) {
    if (!ids.length) return [];
    const table = kind === 'toolIds' ? tools : kind === 'contentIds' ? mcpEntries : artifacts;
    const rows = await this.db
      .select({ id: table.id })
      .from(table)
      .where(
        and(
          await this.resourceFilter(ownerId, kind),
          kind === 'artifactIds'
            ? inArray(table.id, ids)
            : sql`${table.id} = any(${sql.param(ids)}::text[])`,
        ),
      );
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
