import { eq, or, sql, type SQLWrapper } from 'drizzle-orm';
import { profiles, skillVersions, type Database } from '@platform/db';
type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
export async function removeConnectionReferences(
  tx: Transaction,
  input: { connectionId: string; contentIds: string[]; toolIds: string[] },
) {
  const { connectionId } = input;
  const contents = new Set(input.contentIds),
    tools = new Set(input.toolIds);
  const omit = <T>(entries: Record<string, T>, keys: Set<string>) =>
    Object.fromEntries(Object.entries(entries).filter(([id]) => !keys.has(id)));
  const containsAny = (column: SQLWrapper, ids: string[]) =>
    sql`${column} ?| ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb))`;
  const dependentSkills = input.toolIds.length
    ? await tx
        .select({ id: skillVersions.id })
        .from(skillVersions)
        .where(containsAny(skillVersions.dependencies, input.toolIds))
    : [];
  const skillIds = new Set(dependentSkills.map((row) => row.id));
  const rows = await tx
    .select()
    .from(profiles)
    .where(
      or(
        containsAny(profiles.contentIds, input.contentIds),
        containsAny(sql`${profiles.requestable}->'contentIds'`, input.contentIds),
        containsAny(sql`${profiles.catalog}->'content'`, input.contentIds),
        containsAny(profiles.toolIds, input.toolIds),
        containsAny(profiles.skillVersionIds, [...skillIds]),
        containsAny(sql`${profiles.requestable}->'toolIds'`, input.toolIds),
        containsAny(sql`${profiles.catalog}->'tools'`, input.toolIds),
        sql`(${profiles.catalog}->'connectionAliases') ? ${connectionId}`,
        sql`${profiles.connectionIdentities} ? ${connectionId}`,
      ),
    )
    .orderBy(profiles.id)
    .for('update');
  const affected: string[] = [];
  for (const row of rows) {
    const withoutTools = (ids: string[]) => ids.filter((id) => !tools.has(id));
    const withoutContent = (ids: string[]) => ids.filter((id) => !contents.has(id));
    await tx
      .update(profiles)
      .set({
        contentIds: withoutContent(row.contentIds),
        toolIds: withoutTools(row.toolIds),
        pinnedTools: withoutTools(row.pinnedTools),
        skillVersionIds: row.skillVersionIds.filter((id) => !skillIds.has(id)),
        requestable: {
          ...row.requestable,
          contentIds: withoutContent(row.requestable.contentIds),
          toolIds: withoutTools(row.requestable.toolIds),
        },
        catalog: {
          ...row.catalog,
          content: omit(row.catalog.content, contents),
          tools: omit(row.catalog.tools, tools),
          connectionAliases: omit(row.catalog.connectionAliases, new Set([connectionId])),
        },
        connectionIdentities: omit(row.connectionIdentities, new Set([connectionId])),
        revision: sql`${profiles.revision} + 1`,
      })
      .where(eq(profiles.id, row.id));
    affected.push(row.id);
  }
  return affected;
}
