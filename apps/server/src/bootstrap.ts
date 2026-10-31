import { resolve } from 'node:path';
import { createDatabase, databaseUrl } from '@platform/db';
import { envSchema, platformRoot, type Config } from './config.js';
import { databaseSecretStore, resolveSecrets, SecretError, type SecretStore } from './secrets.js';

/**
 * Full startup configuration from just DATABASE_URL: the database password may come from
 * DATABASE_PASSWORD_FILE, PUBLIC_URL/WEB_ORIGIN default to this host, and unset secrets are
 * resolved by `resolveSecrets` (explicit env > DATA_DIR/secrets file > generated).
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
  try {
    const store = (options.store ?? databaseSecretStore)(database.db);
    const { values } = await resolveSecrets({
      env,
      dataDir,
      store,
      generate: env.AUTO_GENERATE_SECRETS?.trim() !== 'false',
      log,
    }).catch((error: unknown) => {
      throw missingMigration(error) ?? error;
    });
    const parsed = envSchema.parse({ ...env, ...values });
    return { ...database, config: { ...parsed, DATA_DIR: dataDir } };
  } catch (error) {
    await database.pool.end();
    throw error;
  }
}

function missingMigration(error: unknown) {
  const code = (error as { cause?: { code?: string }; code?: string }).cause?.code;
  if (code !== '42P01' && (error as { code?: string }).code !== '42P01') return undefined;
  return new SecretError(
    '数据库还没有迁移到当前版本，请先运行 pnpm db:migrate（Docker 部署会自动执行）。',
    {
      cause: error,
    },
  );
}
