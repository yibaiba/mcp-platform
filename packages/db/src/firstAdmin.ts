import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

/** Serializes first-admin checks across processes (arbitrary fixed advisory-lock key). */
const FIRST_ADMIN_LOCK = 7_302_941_001;

/**
 * Makes `userId` an administrator only if no administrator exists and it is the earliest
 * account (created_at, then id). Runs under a transaction-scoped advisory lock so that
 * concurrent sign-ups promote at most one account. Deployments that already have users
 * never match: the new account is not the earliest, so no role changes.
 */
export async function promoteFirstUser(
  db: NodePgDatabase<Record<string, unknown>>,
  userId: string,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${FIRST_ADMIN_LOCK})`);
    const result = await tx.execute(sql`
      update "user" set "role" = 'admin', "updated_at" = now()
      where "id" = ${userId}
        and not exists (select 1 from "user" "existing" where "existing"."role" = 'admin')
        and "id" = (select "first"."id" from "user" "first"
                    order by "first"."created_at", "first"."id" limit 1)
      returning "id"`);
    return result.rows.length > 0;
  });
}
