import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { afterAll, describe, expect, test } from 'vitest';
import {
  createDatabase,
  defaultMigrationsFolder,
  describeMigrationFailure,
  MigrationError,
  readMigrations,
  redactCredentials,
  runMigrations,
} from '../packages/db/src/index.js';
import { loadConfig } from '../apps/server/src/bootstrap.js';

const run = promisify(execFile);
const url = process.env.DATABASE_URL;
if (!url) throw new Error('Tests require a PostgreSQL DATABASE_URL that may create databases');
const admin = createDatabase(url);
const databases: string[] = [];
const directories: string[] = [];
const migrations = readMigrations();
const latest = migrations.at(-1)!.tag;
const quiet = () => {};

afterAll(async () => {
  for (const name of databases)
    await admin.pool.query(`drop database if exists "${name}" with (force)`);
  await admin.pool.end();
  for (const directory of directories) await rm(directory, { recursive: true, force: true });
});

/** A brand-new, empty database (advisory locks and drizzle's bookkeeping are per database). */
async function emptyDatabase() {
  const name = `auto_migrate_${randomUUID().replaceAll('-', '')}`;
  databases.push(name);
  await admin.pool.query(`create database "${name}"`);
  const target = new URL(url!);
  target.pathname = `/${name}`;
  return target.toString();
}
async function tempDir(prefix: string) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}
async function recorded(databaseUrl: string) {
  const { pool } = createDatabase(databaseUrl);
  try {
    const rows = await pool.query<{ hash: string; created_at: string }>(
      'select hash, created_at from drizzle.__drizzle_migrations order by created_at',
    );
    return rows.rows.map((row) => ({ hash: row.hash, when: Number(row.created_at) }));
  } finally {
    await pool.end();
  }
}
async function tableExists(databaseUrl: string, table: string) {
  const { pool } = createDatabase(databaseUrl);
  try {
    return (await pool.query('select to_regclass($1) as name', [table])).rows[0].name !== null;
  } finally {
    await pool.end();
  }
}

describe('automatic migration at startup', () => {
  test('empty database: loadConfig migrates to the latest version and starts', async () => {
    const databaseUrl = await emptyDatabase();
    const dataDir = await tempDir('auto-migrate-');
    const messages: string[] = [];
    const loaded = await loadConfig({
      env: { DATABASE_URL: databaseUrl, DATA_DIR: dataDir, PUBLIC_URL: 'http://localhost:4300' },
      log: (message) => messages.push(message),
    });
    await loaded.pool.end();
    expect(loaded.config.DATABASE_URL).toBe(databaseUrl);
    expect(messages).toContain(
      `数据库迁移完成：应用了 ${migrations.length} 个，当前版本 ${latest}。`,
    );
    expect(await recorded(databaseUrl)).toEqual(
      migrations.map(({ hash, when }) => ({ hash, when })),
    );
    // A second start finds nothing to do and says nothing about migrations.
    messages.length = 0;
    const again = await loadConfig({
      env: { DATABASE_URL: databaseUrl, DATA_DIR: dataDir, PUBLIC_URL: 'http://localhost:4300' },
      log: (message) => messages.push(message),
    });
    await again.pool.end();
    expect(messages.filter((message) => message.includes('迁移'))).toEqual([]);
    expect((await recorded(databaseUrl)).length).toBe(migrations.length);
  });

  test('AUTO_MIGRATE=false skips migration and reports the unmigrated database clearly', async () => {
    const databaseUrl = await emptyDatabase();
    const error = await loadConfig({
      env: {
        DATABASE_URL: databaseUrl,
        DATA_DIR: await tempDir('auto-migrate-'),
        AUTO_MIGRATE: 'false',
      },
      log: quiet,
    }).then(
      () => {
        throw new Error('startup was expected to be refused');
      },
      (reason: unknown) => reason as Error,
    );
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('SecretError');
    expect(error.message).toMatch(/AUTO_MIGRATE=false 关闭了启动时自动迁移/);
    expect(error.message).toMatch(/请运行 pnpm db:migrate/);
    expect(await tableExists(databaseUrl, 'drizzle.__drizzle_migrations')).toBe(false);
    expect(await tableExists(databaseUrl, 'public.user')).toBe(false);
  });

  test('two instances starting together: exactly one applies the migrations', async () => {
    const databaseUrl = await emptyDatabase();
    const first = createDatabase(databaseUrl);
    const second = createDatabase(databaseUrl);
    try {
      let releaseFirst!: () => void;
      const holding = new Promise<void>((resolve) => (releaseFirst = resolve));
      let firstHasLock!: () => void;
      const locked = new Promise<void>((resolve) => (firstHasLock = resolve));
      const secondLog: string[] = [];
      const one = runMigrations(first.pool, {
        afterLock: async () => {
          firstHasLock();
          await holding;
        },
      });
      await locked;
      let secondDone = false;
      const two = runMigrations(second.pool, {
        log: (message) => {
          secondLog.push(message);
          // Only once the second runner is blocked on the lock does the first one proceed.
          if (message.includes('等待')) releaseFirst();
        },
      }).finally(() => (secondDone = true));
      const firstResult = await one;
      expect(firstResult).toEqual({
        applied: migrations.map((it) => it.tag),
        current: latest,
        waited: false,
      });
      const secondResult = await two;
      expect(secondDone).toBe(true);
      expect(secondResult).toEqual({ applied: [], current: latest, waited: true });
      expect(secondLog).toEqual(['另一个实例正在执行数据库迁移，等待它完成…']);
      expect((await recorded(databaseUrl)).length).toBe(migrations.length);
    } finally {
      await first.pool.end();
      await second.pool.end();
    }
    // Real startups racing without hooks (sharing DATA_DIR/secrets, as instances must) also
    // both succeed against a fresh database.
    const raced = await emptyDatabase();
    const env = {
      DATABASE_URL: raced,
      DATA_DIR: await tempDir('auto-migrate-'),
      PUBLIC_URL: 'http://localhost:4300',
    };
    const both = await Promise.allSettled([
      loadConfig({ env, log: quiet }),
      loadConfig({ env, log: quiet }),
    ]);
    for (const loaded of both) if (loaded.status === 'fulfilled') await loaded.value.pool.end();
    expect(both.map((it) => it.status)).toEqual(['fulfilled', 'fulfilled']);
    expect((await recorded(raced)).length).toBe(migrations.length);
  });

  test('a failing migration is rolled back, names itself, and the startup text says what to do', async () => {
    const databaseUrl = await emptyDatabase();
    const database = createDatabase(databaseUrl);
    try {
      await runMigrations(database.pool);
      const folder = await tempDir('auto-migrate-broken-');
      await cp(defaultMigrationsFolder, folder, { recursive: true });
      const journalPath = join(folder, 'meta', '_journal.json');
      const journal = JSON.parse(await readFile(journalPath, 'utf8'));
      journal.entries.push({
        ...journal.entries.at(-1),
        idx: journal.entries.length,
        when: migrations.at(-1)!.when + 1,
        tag: '9999_broken',
      });
      await writeFile(journalPath, JSON.stringify(journal));
      await writeFile(
        join(folder, '9999_broken.sql'),
        'CREATE TABLE "auto_migrate_probe" ("id" text);\n--> statement-breakpoint\nALTER TABLE "no_such_table" ADD COLUMN "x" text;',
      );
      const error = await runMigrations(database.pool, { migrationsFolder: folder }).then(
        () => {
          throw new Error('the broken migration was expected to fail');
        },
        (reason: unknown) => reason as MigrationError,
      );
      expect(error).toBeInstanceOf(MigrationError);
      expect(error.details).toMatchObject({
        tag: '9999_broken',
        statement: 2,
        code: '42P01',
        current: latest,
      });
      expect(error.details.reason).toMatch(/no_such_table/);
      // The first statement of the failed migration was rolled back with it.
      expect(await tableExists(databaseUrl, 'public.auto_migrate_probe')).toBe(false);
      expect((await recorded(databaseUrl)).length).toBe(migrations.length);
      const startup = describeMigrationFailure(error, 'startup');
      expect(startup).toContain('数据库迁移失败，服务没有启动。');
      expect(startup).toContain('失败的迁移：9999_broken（第 2 条语句）');
      expect(startup).toContain('SQLSTATE 42P01');
      expect(startup).toContain(`数据库仍停在 ${latest}`);
      expect(startup).toContain('pnpm db:migrate');
      expect(startup).toContain('AUTO_MIGRATE=false');
      const command = describeMigrationFailure(error, 'command');
      expect(command).toContain('重新运行 pnpm db:migrate');
      expect(command).not.toContain('AUTO_MIGRATE');
      // The lock was released: the real migrations still run (as a no-op) afterwards.
      expect(await runMigrations(database.pool)).toEqual({
        applied: [],
        current: latest,
        waited: false,
      });
    } finally {
      await database.pool.end();
    }
  });

  test('server refuses to start when migration cannot run, without leaking the password', async () => {
    const password = `pw-${randomUUID()}`;
    const result = await run(process.execPath, ['--import', 'tsx', 'apps/server/src/index.ts'], {
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        DATABASE_URL: `postgresql://platform:${password}@127.0.0.1:1/platform`,
        DATA_DIR: await tempDir('auto-migrate-'),
        PUBLIC_URL: 'http://localhost:4300',
      },
      timeout: 30_000,
    }).then(
      () => ({ code: 0, stderr: '' }),
      (error: { code: number; stderr: string }) => error,
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('数据库迁移失败，服务没有启动。');
    expect(result.stderr).toContain('失败的步骤：连接数据库或准备迁移');
    expect(result.stderr).toMatch(/ECONNREFUSED/);
    expect(result.stderr).toContain('AUTO_MIGRATE=false');
    expect(result.stderr).not.toContain(password);
  });

  test('pnpm db:migrate (the Compose migrate service) stays compatible and idempotent', async () => {
    // Databases migrated by drizzle's own migrator (every earlier release) are already current.
    const legacy = await emptyDatabase();
    const database = createDatabase(legacy);
    try {
      await migrate(database.db, { migrationsFolder: defaultMigrationsFolder });
      expect(await runMigrations(database.pool)).toEqual({
        applied: [],
        current: latest,
        waited: false,
      });
    } finally {
      await database.pool.end();
    }
    // The command after an automatic startup migration, and again: both no-ops, exit 0.
    const databaseUrl = await emptyDatabase();
    const loaded = await loadConfig({
      env: {
        DATABASE_URL: databaseUrl,
        DATA_DIR: await tempDir('auto-migrate-'),
        PUBLIC_URL: 'http://localhost:4300',
      },
      log: quiet,
    });
    await loaded.pool.end();
    for (let attempt = 0; attempt < 2; attempt++) {
      const { stdout } = await run(
        process.execPath,
        ['--import', 'tsx', 'packages/db/src/migrate.ts'],
        {
          env: { PATH: process.env.PATH, HOME: process.env.HOME, DATABASE_URL: databaseUrl },
          timeout: 30_000,
        },
      );
      expect(stdout).toContain(`数据库已是最新（${latest}），没有需要应用的迁移。`);
    }
    expect((await recorded(databaseUrl)).length).toBe(migrations.length);
  });

  test('connection strings in driver errors are redacted', () => {
    expect(
      redactCredentials('connect to postgresql://platform:s3cret@db:5432/platform failed'),
    ).toBe('connect to postgresql://platform:***@db:5432/platform failed');
    expect(redactCredentials('no credentials here: postgres://db/platform')).toBe(
      'no credentials here: postgres://db/platform',
    );
  });
});
