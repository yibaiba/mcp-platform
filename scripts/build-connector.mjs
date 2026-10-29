import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { connectorTargets } from '../packages/contracts/src/connectorDistribution.ts';
if (!process.argv.includes('--assets-built'))
  execFileSync(
    process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
    ['--filter', 'web', 'build:local'],
    { cwd: fileURLToPath(new URL('../', import.meta.url)), stdio: 'inherit', timeout: 60_000 },
  );
const root = fileURLToPath(new URL('../connector/', import.meta.url));
// Refuse to distribute a CLI whose standalone management page was not built.
readFileSync(join(root, 'internal/localhttp/assets/index.html'));
mkdirSync(join(root, 'bin'), { recursive: true });
const sums = [];
for (const { os: GOOS, arch: GOARCH, filename: name } of connectorTargets) {
  const output = join(root, 'bin', name);
  execFileSync('go', ['build', '-trimpath', '-o', output, './cmd/connector'], {
    cwd: root,
    env: { ...process.env, GOOS, GOARCH, CGO_ENABLED: '0' },
    stdio: 'inherit',
    timeout: 180_000,
  });
  sums.push(`${createHash('sha256').update(readFileSync(output)).digest('hex')}  ${name}`);
  console.log(`Built ${name}`);
}
writeFileSync(join(root, 'bin', 'SHA256SUMS'), `${sums.join('\n')}\n`);
