import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, describe, expect, test } from 'vitest';
import { createDatabase, databaseUrl, user } from '../packages/db/src/index.js';
import {
  generatedSecrets,
  resolveSecrets,
  secretFingerprint,
  SecretError,
  type SecretName,
  type SecretStore,
} from '../apps/server/src/secrets.js';
import { loadConfig } from '../apps/server/src/bootstrap.js';
import { envSchema } from '../apps/server/src/config.js';

const directories: string[] = [];
async function dataDir() {
  const directory = await mkdtemp(join(tmpdir(), 'platform-secrets-'));
  directories.push(directory);
  return directory;
}
function memoryStore(
  options: { users?: boolean; recorded?: Partial<Record<SecretName, string>> } = {},
) {
  const fingerprints = new Map<SecretName, string>(
    Object.entries(options.recorded ?? {}) as [SecretName, string][],
  );
  const store: SecretStore & { fingerprints: typeof fingerprints } = {
    fingerprints,
    hasUsers: async () => options.users ?? false,
    fingerprint: async (name) => fingerprints.get(name),
    record: async (name, fingerprint) => {
      if (!fingerprints.has(name)) fingerprints.set(name, fingerprint);
      return fingerprints.get(name)!;
    },
  };
  return store;
}
const names = generatedSecrets.map((spec) => spec.name);
const explicitKeys = () => ({
  BETTER_AUTH_SECRET: randomBytes(32).toString('hex'),
  ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  DEVICE_AUTH_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
});
const mode = async (path: string) => ((await stat(path)).mode & 0o777).toString(8);

afterAll(async () => {
  for (const directory of directories) await rm(directory, { recursive: true, force: true });
});

describe('resolveSecrets', () => {
  test('fresh deployment: every missing key is generated once, stored 0600 and reused', async () => {
    const dir = await dataDir();
    const store = memoryStore();
    const logs: string[] = [];
    const first = await resolveSecrets({
      env: {},
      dataDir: dir,
      store,
      generate: true,
      log: (m) => logs.push(m),
    });
    expect(first.resolved.map((entry) => entry.source)).toEqual(names.map(() => 'generated'));
    expect(await mode(join(dir, 'secrets'))).toBe('700');
    for (const name of names) {
      expect(await mode(join(dir, 'secrets', name))).toBe('600');
      expect((await readFile(join(dir, 'secrets', name), 'utf8')).trim()).toBe(first.values[name]);
      expect(store.fingerprints.get(name)).toBe(secretFingerprint(name, first.values[name]));
    }
    // Generated values satisfy the server's own validation (32-byte canonical base64 etc.).
    const parsed = envSchema.parse({
      DATABASE_URL: 'postgresql://localhost/x',
      PUBLIC_URL: 'http://localhost:4300',
      WEB_ORIGIN: 'http://localhost:4300',
      ...first.values,
    });
    expect(parsed.BETTER_AUTH_SECRET).toHaveLength(64);
    expect(Buffer.from(first.values.ENCRYPTION_KEY, 'base64')).toHaveLength(32);
    // Logs name the file and ask for a backup, never print the value.
    expect(logs).toHaveLength(4);
    for (const name of names) expect(logs.join('\n')).not.toContain(first.values[name]);
    expect(logs[0]).toContain(join(dir, 'secrets', 'BETTER_AUTH_SECRET'));
    // Restart: the same values come back from the files; nothing is regenerated.
    const again = await resolveSecrets({
      env: {},
      dataDir: dir,
      store: { ...store, hasUsers: async () => true },
      generate: true,
    });
    expect(again.values).toEqual(first.values);
    expect(again.resolved.map((entry) => entry.source)).toEqual(names.map(() => 'file'));
  });

  test('explicit values always win, are never written, and never overwrite a stored file', async () => {
    const dir = await dataDir();
    await mkdir(join(dir, 'secrets'), { recursive: true });
    await writeFile(join(dir, 'secrets', 'ENCRYPTION_KEY'), 'stored-value\n');
    const env = explicitKeys();
    const result = await resolveSecrets({
      env,
      dataDir: dir,
      store: memoryStore(),
      generate: true,
    });
    expect(result.values).toMatchObject(env);
    expect(result.resolved.slice(0, 3).map((entry) => entry.source)).toEqual(['env', 'env', 'env']);
    expect(await readFile(join(dir, 'secrets', 'ENCRYPTION_KEY'), 'utf8')).toBe('stored-value\n');
    await expect(stat(join(dir, 'secrets', 'BETTER_AUTH_SECRET'))).rejects.toThrow(/ENOENT/);
    // Compose passes unset values as empty strings: those mean "not set".
    const blank = await resolveSecrets({
      env: { BETTER_AUTH_SECRET: '' },
      dataDir: await dataDir(),
      store: memoryStore(),
      generate: true,
    });
    expect(blank.resolved[0]!.source).toBe('generated');
  });

  test('upgrade: existing accounts and env keys keep working; only the Pi file key may be added', async () => {
    const dir = await dataDir();
    const env = explicitKeys();
    const store = memoryStore({ users: true });
    const result = await resolveSecrets({ env, dataDir: dir, store, generate: true });
    expect(result.values).toMatchObject(env);
    expect(result.resolved.map((entry) => entry.source)).toEqual([
      'env',
      'env',
      'env',
      'generated',
    ]);
    // First start after the upgrade records the fingerprints of the values in use.
    expect(store.fingerprints.get('ENCRYPTION_KEY')).toBe(
      secretFingerprint('ENCRYPTION_KEY', env.ENCRYPTION_KEY),
    );
  });

  test('upgrade: a missing core key is never replaced once accounts exist', async () => {
    const dir = await dataDir();
    const { ENCRYPTION_KEY: _dropped, ...env } = explicitKeys();
    const attempt = resolveSecrets({
      env,
      dataDir: dir,
      store: memoryStore({ users: true }),
      generate: true,
    });
    await expect(attempt).rejects.toThrow(SecretError);
    await expect(attempt).rejects.toThrow(/缺少 ENCRYPTION_KEY，但数据库里已有账号/);
    await expect(stat(join(dir, 'secrets', 'ENCRYPTION_KEY'))).rejects.toThrow(/ENOENT/);
  });

  test('a key this database already used is never regenerated, even without accounts', async () => {
    const dir = await dataDir();
    const store = memoryStore({ recorded: { PI_MCP_ADAPTER_OAUTH_FILE_KEY: 'f'.repeat(64) } });
    await expect(
      resolveSecrets({ env: explicitKeys(), dataDir: dir, store, generate: true }),
    ).rejects.toThrow(/缺少 PI_MCP_ADAPTER_OAUTH_FILE_KEY，但这个数据库已经用过它/);
  });

  test('a changed key or an instance with its own keys is refused with a clear reason', async () => {
    const env = explicitKeys();
    const store = memoryStore();
    await resolveSecrets({ env, dataDir: await dataDir(), store, generate: true });
    // Same database, different BETTER_AUTH_SECRET (edited .env, or a second instance).
    const changed = resolveSecrets({
      env: { ...env, BETTER_AUTH_SECRET: randomBytes(32).toString('hex') },
      dataDir: await dataDir(),
      store,
      generate: true,
    });
    await expect(changed).rejects.toThrow(
      /BETTER_AUTH_SECRET（来自 环境变量 BETTER_AUTH_SECRET）和这个数据库第一次使用的值不一致/,
    );
    await expect(changed).rejects.toThrow(/多个实例没有共享同一个 DATA_DIR\/secrets/);
    // A second instance with its own (empty) data directory would generate other keys: refused.
    const secondInstance = resolveSecrets({
      env: {},
      dataDir: await dataDir(),
      store,
      generate: true,
    });
    await expect(secondInstance).rejects.toThrow(/这个数据库已经用过它/);
  });

  test('concurrent first starts sharing one data directory agree on the same keys', async () => {
    const dir = await dataDir();
    const store = memoryStore();
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        resolveSecrets({ env: {}, dataDir: dir, store, generate: true }),
      ),
    );
    for (const result of results) expect(result.values).toEqual(results[0]!.values);
    expect(
      results.flatMap((result) => result.resolved).filter((entry) => entry.source === 'generated'),
    ).toHaveLength(4);
  });

  test('an unwritable data directory fails with what to do instead', async () => {
    const expected =
      /无法把自动生成的 BETTER_AUTH_SECRET 写入 .*请让 DATA_DIR 可写.*或显式设置环境变量 BETTER_AUTH_SECRET/;
    const parent = await dataDir();
    const notADirectory = join(parent, 'file');
    await writeFile(notADirectory, '');
    await expect(
      resolveSecrets({ env: {}, dataDir: notADirectory, store: memoryStore(), generate: true }),
    ).rejects.toThrow(expected);
    // Read-only data directory (e.g. a volume mounted read-only or owned by another user).
    const readOnly = join(parent, 'readonly');
    await mkdir(readOnly, { mode: 0o500 });
    try {
      await expect(
        resolveSecrets({ env: {}, dataDir: readOnly, store: memoryStore(), generate: true }),
      ).rejects.toThrow(expected);
    } finally {
      await chmod(readOnly, 0o700);
    }
  });

  test('AUTO_GENERATE_SECRETS=false requires every key from env or file', async () => {
    await expect(
      resolveSecrets({ env: {}, dataDir: await dataDir(), store: memoryStore(), generate: false }),
    ).rejects.toThrow(/缺少 BETTER_AUTH_SECRET，且 AUTO_GENERATE_SECRETS=false/);
  });
});

describe('databaseUrl', () => {
  test('completes a password-less URL from DATABASE_PASSWORD_FILE; an inline password wins', async () => {
    const file = join(await dataDir(), 'pw');
    await writeFile(file, 'p@ss/word\n');
    expect(
      databaseUrl({
        DATABASE_URL: 'postgresql://platform@db:5432/platform',
        DATABASE_PASSWORD_FILE: file,
      }),
    ).toBe('postgresql://platform:p%40ss%2Fword@db:5432/platform');
    expect(
      databaseUrl({
        DATABASE_URL: 'postgresql://platform:@db:5432/platform',
        DATABASE_PASSWORD_FILE: file,
      }),
    ).toBe('postgresql://platform:p%40ss%2Fword@db:5432/platform');
    expect(
      databaseUrl({
        DATABASE_URL: 'postgresql://platform:inline@db/platform',
        DATABASE_PASSWORD_FILE: file,
      }),
    ).toBe('postgresql://platform:inline@db/platform');
    expect(() =>
      databaseUrl({
        DATABASE_URL: 'postgresql://platform@db/platform',
        DATABASE_PASSWORD_FILE: `${file}-missing`,
      }),
    ).toThrow(/无法读取 DATABASE_PASSWORD_FILE/);
  });
});

describe('compose init', () => {
  const run = promisify(execFile);
  test('generates the database password once (0600), keeps it, and lets an explicit value win', async () => {
    const dir = join(await dataDir(), 'secrets');
    const init = (env: Record<string, string>) =>
      run(process.execPath, ['scripts/compose-init.mjs'], {
        env: { ...process.env, POSTGRES_PASSWORD: '', PLATFORM_SECRETS_DIR: dir, ...env },
      });
    await init({});
    const generated = await readFile(join(dir, 'POSTGRES_PASSWORD'), 'utf8');
    expect(generated).toMatch(/^[0-9a-f]{64}$/);
    expect(await mode(join(dir, 'POSTGRES_PASSWORD'))).toBe('600');
    expect(await mode(dir)).toBe('700');
    await init({});
    expect(await readFile(join(dir, 'POSTGRES_PASSWORD'), 'utf8')).toBe(generated);
    await init({ POSTGRES_PASSWORD: 'explicit-password' });
    expect(await readFile(join(dir, 'POSTGRES_PASSWORD'), 'utf8')).toBe('explicit-password');
    expect(await mode(join(dir, 'POSTGRES_PASSWORD'))).toBe('600');
  });
});

/** Real database: each case gets its own schema with copies of `user` and `deployment_secrets`. */
describe('loadConfig against PostgreSQL', () => {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('Tests require a migrated PostgreSQL DATABASE_URL');
  const admin = createDatabase(url);
  const schemas: string[] = [];
  afterAll(async () => {
    for (const schema of schemas) await admin.pool.query(`drop schema "${schema}" cascade`);
    await admin.pool.end();
  });
  async function deployment() {
    const schema = `deploy_secrets_${randomUUID().replaceAll('-', '')}`;
    schemas.push(schema);
    await admin.pool.query(`create schema "${schema}"`);
    for (const table of ['user', 'deployment_secrets'])
      await admin.pool.query(
        `create table "${schema}"."${table}" (like public."${table}" including all)`,
      );
    const separator = url!.includes('?') ? '&' : '?';
    return `${url}${separator}options=${encodeURIComponent(`-c search_path=${schema}`)}`;
  }
  const quiet = () => {};

  test('only DATABASE_URL: defaults filled, keys generated and stable across restarts', async () => {
    const databaseUrl = await deployment();
    const dir = await dataDir();
    const env = { DATABASE_URL: databaseUrl, DATA_DIR: dir };
    const first = await loadConfig({ env, log: quiet });
    await first.pool.end();
    expect(first.config.PUBLIC_URL).toBe('http://localhost:4300');
    expect(first.config.WEB_ORIGIN).toBe('http://localhost:4300');
    expect(first.config.ALLOW_REGISTRATION).toBe('false');
    const second = await loadConfig({ env, log: quiet });
    await second.pool.end();
    for (const name of generatedSecrets.map((spec) => spec.name))
      expect(second.config[name]).toBe(first.config[name]);
    // The database holds fingerprints only, never the values.
    const rows = await admin.pool.query(
      `select name, fingerprint from "${schemas.at(-1)}".deployment_secrets order by name`,
    );
    expect(rows.rows.map((row) => row.name)).toEqual(
      [...generatedSecrets.map((spec) => spec.name)].sort(),
    );
    for (const row of rows.rows) expect(Object.values(first.config)).not.toContain(row.fingerprint);
    // Losing the data volume after accounts exist is refused rather than silently re-keyed.
    const { db, pool } = createDatabase(databaseUrl);
    await db
      .insert(user)
      .values({ id: randomUUID(), name: 'Admin', email: `${randomUUID()}@example.test` });
    await pool.end();
    await expect(
      loadConfig({ env: { ...env, DATA_DIR: await dataDir() }, log: quiet }),
    ).rejects.toThrow(/缺少 BETTER_AUTH_SECRET，但这个数据库已经用过它/);
    // A different explicit value is refused too.
    await expect(
      loadConfig({
        env: { ...env, ENCRYPTION_KEY: randomBytes(32).toString('base64') },
        log: quiet,
      }),
    ).rejects.toThrow(
      /ENCRYPTION_KEY（来自 环境变量 ENCRYPTION_KEY）和这个数据库第一次使用的值不一致/,
    );
  });

  test('upgrade: existing env keys are adopted as-is and written nowhere', async () => {
    const databaseUrl = await deployment();
    const { db, pool } = createDatabase(databaseUrl);
    await db
      .insert(user)
      .values({ id: randomUUID(), name: 'Old', email: `${randomUUID()}@example.test` });
    await pool.end();
    const dir = await dataDir();
    const keys = explicitKeys();
    const env = {
      DATABASE_URL: databaseUrl,
      DATA_DIR: dir,
      PUBLIC_URL: 'https://mcp.example.test',
      ...keys,
    };
    const loaded = await loadConfig({ env, log: quiet });
    await loaded.pool.end();
    expect(loaded.config).toMatchObject({ ...keys, WEB_ORIGIN: 'https://mcp.example.test' });
    for (const name of Object.keys(keys))
      await expect(stat(join(dir, 'secrets', name))).rejects.toThrow(/ENOENT/);
    const again = await loadConfig({ env, log: quiet });
    await again.pool.end();
    expect(again.config).toMatchObject(keys);
  });

  test('missing migration is reported as such', async () => {
    const schema = `deploy_secrets_${randomUUID().replaceAll('-', '')}`;
    schemas.push(schema);
    await admin.pool.query(`create schema "${schema}"`);
    await admin.pool.query(`create table "${schema}"."user" (like public."user" including all)`);
    const separator = url.includes('?') ? '&' : '?';
    await expect(
      loadConfig({
        env: {
          DATABASE_URL: `${url}${separator}options=${encodeURIComponent(`-c search_path=${schema}`)}`,
          DATA_DIR: await dataDir(),
        },
        log: quiet,
      }),
    ).rejects.toThrow(/请先运行 pnpm db:migrate/);
  });
});
