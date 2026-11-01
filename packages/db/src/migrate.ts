import { config } from 'dotenv';
import { createDatabase, databaseUrl } from './index.js';
import { describeMigrationFailure, MigrationError, runMigrations } from './migrations.js';
config({ path: new URL('../../../.env', import.meta.url).pathname });
// Same runner and advisory lock as server startup (AUTO_MIGRATE), so running this next to a
// starting server, or again after it, is a safe no-op.
let pool: ReturnType<typeof createDatabase>['pool'] | undefined;
try {
  pool = createDatabase(databaseUrl()).pool;
  const result = await runMigrations(pool, { log: (message) => console.log(message) });
  console.log(
    result.applied.length
      ? `数据库迁移完成：应用了 ${result.applied.length} 个，当前版本 ${result.current}。`
      : `数据库已是最新（${result.current ?? '没有迁移'}），没有需要应用的迁移。`,
  );
} catch (error) {
  console.error(
    error instanceof MigrationError
      ? describeMigrationFailure(error, 'command')
      : error instanceof Error
        ? error.message
        : error,
  );
  process.exitCode = 1;
} finally {
  await pool?.end();
}
