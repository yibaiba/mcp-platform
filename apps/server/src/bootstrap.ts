import { resolve } from 'node:path';
import { createDatabase, databaseUrl, runMigrations } from '@platform/db';
import { envSchema, platformRoot, type Config } from './config.js';
import { databaseSecretStore, resolveSecrets, SecretError, type SecretStore } from './secrets.js';

/**
 * Full startup configuration from just DATABASE_URL: the database password may come from
 * DATABASE_PASSWORD_FILE, PUBLIC_URL/WEB_ORIGIN default to this host, and unset secrets are
 * resolved by `resolveSecrets` (explicit env > DATA_DIR/secrets file > generated).
 *
 * Pending database migrations are applied first (AUTO_MIGRATE, on unless `false`) under the
 * same advisory lock as `pnpm db:migrate`; a failed migration rejects with a MigrationError.
 */
export async function loadConfig(
  options: {
    env?: Record<string, string | undefined>;
    store?: (db: ReturnType<typeof createDatabase>['db']) => SecretStore;
    log?: (message: string) => void;
  } = {},
): Promise<{ config: Config } & ReturnType<typeof createDatabase>> {
  const log = options.log ?? ((message: string) => console.warn(message));
  const env = { ...(options.env ?? process.env) };
  env.DATABASE_URL = databaseUrl(env as NodeJS.ProcessEnv);
  const port = env.PORT?.trim() || '4300';
  if (!env.PUBLIC_URL?.trim()) {
    env.PUBLIC_URL = `http://localhost:${port}`;
    log(`未设置 PUBLIC_URL，暂用 ${env.PUBLIC_URL}；从其他机器访问前请设置成对外地址。`);
  }
  if (!env.WEB_ORIGIN?.trim()) env.WEB_ORIGIN = new URL(env.PUBLIC_URL).origin;
  const dataDir = resolve(platformRoot, env.DATA_DIR?.trim() || '.data');
  const database = createDatabase(env.DATABASE_URL);
  const autoMigrate = env.AUTO_MIGRATE?.trim() !== 'false';
  try {
    if (autoMigrate) {
      const result = await runMigrations(database.pool, { log });
      if (result.applied.length)
        log(`数据库迁移完成：应用了 ${result.applied.length} 个，当前版本 ${result.current}。`);
    }
    const store = (options.store ?? databaseSecretStore)(database.db);
    const { values } = await resolveSecrets({
      env,
      dataDir,
      store,
      generate: env.AUTO_GENERATE_SECRETS?.trim() !== 'false',
      log,
    }).catch((error: unknown) => {
      throw missingMigration(error, autoMigrate) ?? error;
    });
    const parsed = envSchema.parse({ ...env, ...values });
    return { ...database, config: { ...parsed, DATA_DIR: dataDir } };
  } catch (error) {
    await database.pool.end();
    throw error;
  }
}

function missingMigration(error: unknown, autoMigrate: boolean) {
  const code = (error as { cause?: { code?: string }; code?: string }).cause?.code;
  if (code !== '42P01' && (error as { code?: string }).code !== '42P01') return undefined;
  return new SecretError(
    autoMigrate
      ? '数据库缺少需要的表，但迁移记录（drizzle.__drizzle_migrations）显示已是最新。请确认 DATABASE_URL 指向正确的数据库和 schema（search_path）；如果表被手动删除，请从备份恢复。'
      : '数据库还没有迁移到当前版本，而 AUTO_MIGRATE=false 关闭了启动时自动迁移。请运行 pnpm db:migrate（Docker Compose 部署由 migrate 服务执行），或去掉 AUTO_MIGRATE=false 后重新启动。',
    { cause: error },
  );
}
