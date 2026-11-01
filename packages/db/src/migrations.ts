import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Pool, PoolClient } from 'pg';

/**
 * Applies pending migrations from `packages/db/migrations` in the same format and bookkeeping
 * as drizzle's migrator (`drizzle.__drizzle_migrations`, sha256 hash, journal `when` as
 * `created_at`), so databases migrated by earlier `pnpm db:migrate` runs need nothing new.
 *
 * Differences: one session-level advisory lock serialises every runner (server startup,
 * `pnpm db:migrate`, the Compose `migrate` service), so concurrent starts never migrate twice;
 * and a failure names the migration and statement that failed. All pending migrations run in
 * one transaction, as drizzle does, so a failure leaves the database at its previous version.
 */
export const MIGRATION_LOCK_KEY = 7_263_660_010n;
export const defaultMigrationsFolder = fileURLToPath(new URL('../migrations', import.meta.url));

export type MigrationFile = { tag: string; when: number; hash: string; statements: string[] };
export type MigrationResult = {
  /** Tags applied by this run, oldest first; empty when the database was already current. */
  applied: string[];
  /** Newest migration the database is at after this run (undefined: no migrations at all). */
  current: string | undefined;
  /** True when another runner held the lock first and this one waited for it. */
  waited: boolean;
};

export class MigrationError extends Error {
  override name = 'MigrationError';
  constructor(
    message: string,
    readonly details: {
      /** Failed migration tag; undefined when the failure was before any migration ran. */
      tag?: string;
      /** 1-based statement number inside that migration. */
      statement?: number;
      /** PostgreSQL SQLSTATE, when the server reported one. */
      code?: string;
      /** Reason with any connection-string credentials removed. */
      reason: string;
      /** Version the database stays at (undefined: nothing applied yet). */
      current?: string;
    },
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

export function readMigrations(folder = defaultMigrationsFolder): MigrationFile[] {
  const journal = JSON.parse(readFileSync(`${folder}/meta/_journal.json`, 'utf8')) as {
    entries: { tag: string; when: number }[];
  };
  return journal.entries.map(({ tag, when }) => {
    const query = readFileSync(`${folder}/${tag}.sql`, 'utf8');
    return {
      tag,
      when,
      hash: createHash('sha256').update(query).digest('hex'),
      statements: query.split('--> statement-breakpoint').filter((it) => it.trim()),
    };
  });
}

/** Removes `user:password@` from any connection string a driver error may echo back. */
export function redactCredentials(text: string): string {
  return text.replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]*):[^\s@/]*@/gi, '$1:***@');
}

function reasonOf(error: unknown): { reason: string; code?: string } {
  const value = error as { message?: string; code?: string; detail?: string; hint?: string };
  const parts = [value?.message || String(error)];
  if (value?.detail) parts.push(`详情：${value.detail}`);
  if (value?.hint) parts.push(`提示：${value.hint}`);
  const code =
    typeof value?.code === 'string' && /^[0-9A-Z]{5}$/.test(value.code) ? value.code : undefined;
  return { reason: redactCredentials(parts.join('；')), code };
}

async function lock(client: PoolClient, key: bigint, log: (message: string) => void) {
  const tried = await client.query<{ locked: boolean }>(
    'select pg_try_advisory_lock($1) as locked',
    [key.toString()],
  );
  if (tried.rows[0]?.locked) return false;
  log('另一个实例正在执行数据库迁移，等待它完成…');
  await client.query('select pg_advisory_lock($1)', [key.toString()]);
  return true;
}

export async function runMigrations(
  pool: Pool,
  options: {
    migrationsFolder?: string;
    log?: (message: string) => void;
    lockKey?: bigint;
    /** Test hook: runs after the lock is held, before anything is read or applied. */
    afterLock?: () => Promise<void>;
  } = {},
): Promise<MigrationResult> {
  const log = options.log ?? (() => {});
  const key = options.lockKey ?? MIGRATION_LOCK_KEY;
  let migrations: MigrationFile[];
  try {
    migrations = readMigrations(options.migrationsFolder);
  } catch (error) {
    const { reason } = reasonOf(error);
    throw new MigrationError(`无法读取迁移文件：${reason}`, { reason }, { cause: error });
  }
  let client: PoolClient;
  try {
    client = await pool.connect();
  } catch (error) {
    const { reason, code } = reasonOf(error);
    throw new MigrationError(`连接数据库失败：${reason}`, { reason, code }, { cause: error });
  }
  let locked = false;
  let current: string | undefined;
  let tag: string | undefined;
  let statement: number | undefined;
  try {
    const waited = await lock(client, key, log);
    locked = true;
    await options.afterLock?.();
    await client.query('create schema if not exists "drizzle"');
    await client.query(
      'create table if not exists "drizzle"."__drizzle_migrations" (id serial primary key, hash text not null, created_at bigint)',
    );
    const last = await client.query<{ created_at: string | null }>(
      'select created_at from "drizzle"."__drizzle_migrations" order by created_at desc limit 1',
    );
    const lastWhen = last.rows[0] ? Number(last.rows[0].created_at) : undefined;
    current =
      lastWhen === undefined
        ? undefined
        : ([...migrations].reverse().find((it) => it.when <= lastWhen)?.tag ?? `@${lastWhen}`);
    // Same rule as drizzle: everything newer than the newest recorded migration is pending.
    const pending = migrations.filter((it) => lastWhen === undefined || lastWhen < it.when);
    if (!pending.length) return { applied: [], current, waited };
    log(`正在应用 ${pending.length} 个数据库迁移：${pending.map((it) => it.tag).join(', ')}`);
    await client.query('begin');
    try {
      for (const migration of pending) {
        tag = migration.tag;
        for (const [index, sql] of migration.statements.entries()) {
          statement = index + 1;
          await client.query(sql);
        }
        statement = undefined;
        await client.query(
          'insert into "drizzle"."__drizzle_migrations" ("hash", "created_at") values ($1, $2)',
          [migration.hash, migration.when],
        );
      }
      await client.query('commit');
    } catch (error) {
      await client.query('rollback').catch(() => {});
      throw error;
    }
    return { applied: pending.map((it) => it.tag), current: pending.at(-1)!.tag, waited };
  } catch (error) {
    if (error instanceof MigrationError) throw error;
    const { reason, code } = reasonOf(error);
    const where = tag ? `迁移 ${tag}${statement ? `（第 ${statement} 条语句）` : ''}` : '准备迁移';
    throw new MigrationError(
      `${where}失败：${reason}${code ? `（SQLSTATE ${code}）` : ''}`,
      { tag, statement, code, reason, current },
      { cause: error },
    );
  } finally {
    if (locked)
      await client.query('select pg_advisory_unlock($1)', [key.toString()]).catch(() => {});
    client.release();
  }
}

/**
 * Operator-facing text for a failed run. `startup` is the server refusing to start; `command`
 * is `pnpm db:migrate` (also the Compose `migrate` service).
 */
export function describeMigrationFailure(error: MigrationError, context: 'startup' | 'command') {
  const { tag, statement, code, reason, current } = error.details;
  const lines = [
    context === 'startup' ? '数据库迁移失败，服务没有启动。' : '数据库迁移失败。',
    tag
      ? `  失败的迁移：${tag}${statement ? `（第 ${statement} 条语句）` : ''}`
      : '  失败的步骤：连接数据库或准备迁移',
    `  原因：${reason}${code ? `（SQLSTATE ${code}）` : ''}`,
  ];
  if (tag)
    lines.push(
      `  本次要应用的迁移已全部回滚，数据库仍停在 ${current ?? '空库（还没有任何迁移）'}。`,
    );
  lines.push(
    '处理：',
    '  1. 按上面的原因修复（数据库权限、扩展如 pgvector、冲突的数据或表），必要时先备份数据库；',
    context === 'startup'
      ? '  2. 重新启动服务会再次自动迁移；也可以先手动运行 pnpm db:migrate 确认已经修好；'
      : '  2. 重新运行 pnpm db:migrate（重复运行是安全的，已应用的迁移会跳过）；',
  );
  if (context === 'startup')
    lines.push(
      '  3. 如果迁移由外部流程负责（例如 Docker Compose 的 migrate 服务或发布流水线），可设置 AUTO_MIGRATE=false 跳过启动时迁移。',
    );
  return lines.join('\n');
}
