import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, openSync, closeSync, chmodSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'dotenv';
const cwd = fileURLToPath(new URL('../', import.meta.url));
if (!process.argv[2]) throw new Error('Usage: pnpm backup /absolute/new-backup-directory');
const configuration = parse(readFileSync(resolve(cwd, '.env')));
const databaseUrl = process.env.DATABASE_URL ?? configuration.DATABASE_URL;
if (!databaseUrl) throw new Error('Set DATABASE_URL to the external PostgreSQL database');
const connection = backupConnection(databaseUrl);
execFileSync('pg_dump', ['--version'], { timeout: 10_000, stdio: 'ignore' });
const destination = resolve(process.argv[2]);
mkdirSync(destination, { mode: 0o700 });
const compose = (args, extra = {}) =>
  execFileSync('docker', ['compose', ...args], {
    cwd,
    timeout: 180_000,
    stdio: 'inherit',
    ...extra,
  });
compose(['stop', 'server']);
try {
  copyFileSync(resolve(cwd, '.env'), resolve(destination, 'platform.env'));
  chmodSync(resolve(destination, 'platform.env'), 0o600);
  const database = openSync(resolve(destination, 'database.dump'), 'wx', 0o600);
  try {
    execFileSync('pg_dump', ['--format=custom', '--dbname', connection.url], {
      env: connection.env,
      timeout: 180_000,
      stdio: ['ignore', database, 'inherit'],
    });
  } finally {
    closeSync(database);
  }
  const files = openSync(resolve(destination, 'files.tar'), 'wx', 0o600);
  try {
    compose(
      ['run', '--rm', '--no-deps', '-T', 'server', 'tar', '-C', '/app/.data', '-cf', '-', '.'],
      { stdio: ['ignore', files, 'inherit'] },
    );
  } finally {
    closeSync(files);
  }
  console.log('Backup complete. Keep platform.env private; it contains the encryption key.');
} finally {
  compose(['start', 'server']);
}

function backupConnection(value) {
  try {
    const url = new URL(value);
    const passwords = url.searchParams.getAll('password');
    const env = { ...process.env };
    if (url.password || passwords.length)
      env.PGPASSWORD = passwords.at(-1) ?? decodeURIComponent(url.password);
    url.password = '';
    url.searchParams.delete('password');
    return { url: url.toString(), env };
  } catch {
    throw new Error('DATABASE_URL must be a valid database connection URL');
  }
}
