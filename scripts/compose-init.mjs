// One-shot `init` service of docker-compose.yml (runs as root in the app image, before the
// database starts). Provides the bundled PostgreSQL password without hand-filling `.env`:
// an explicit POSTGRES_PASSWORD wins (and is mirrored into the file), an existing file is kept,
// otherwise a random password is generated. The file is mode 0600, owned by the app user;
// the database container reads it as root through POSTGRES_PASSWORD_FILE.
import { randomBytes } from 'node:crypto';
import { chmodSync, chownSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const directory = process.env.PLATFORM_SECRETS_DIR ?? '/run/platform-secrets';
const file = join(directory, 'POSTGRES_PASSWORD');
const owner = { uid: 1000, gid: 1000 }; // `node` in the app image
// Ownership only changes as root (the Compose service); a test run as any user just sets modes.
const chown = process.getuid?.() === 0 ? chownSync : () => {};
const explicit = process.env.POSTGRES_PASSWORD?.trim() || undefined;
let existing;
try {
  existing = readFileSync(file, 'utf8').trim() || undefined;
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
mkdirSync(directory, { recursive: true, mode: 0o700 });
chown(directory, owner.uid, owner.gid);
chmodSync(directory, 0o700);
const value = explicit ?? existing ?? randomBytes(32).toString('hex');
if (value !== existing) {
  if (existing && explicit)
    console.warn(
      'POSTGRES_PASSWORD differs from the stored password; using the explicit value. PostgreSQL only applies a password when its data volume is first created.',
    );
  const temporary = `${file}.${process.pid}`;
  writeFileSync(temporary, value, { mode: 0o600, flag: 'wx' });
  renameSync(temporary, file);
  console.log(
    explicit
      ? 'Using POSTGRES_PASSWORD from the environment.'
      : `Generated the PostgreSQL password into the secrets volume (${file}, mode 0600).`,
  );
}
chown(file, owner.uid, owner.gid);
chmodSync(file, 0o600);
