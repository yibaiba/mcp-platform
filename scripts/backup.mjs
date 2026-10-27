import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, openSync, closeSync, chmodSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const cwd = fileURLToPath(new URL('../', import.meta.url));
if (!process.argv[2]) throw new Error('Usage: pnpm backup /absolute/new-backup-directory');
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
    compose(['exec', '-T', 'db', 'pg_dump', '-U', 'platform', '-d', 'platform', '-Fc'], {
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
