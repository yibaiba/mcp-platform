import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const root = fileURLToPath(new URL('../connector/', import.meta.url));
mkdirSync(join(root, 'bin'), { recursive: true });
const sums = [];
for (const GOOS of ['darwin', 'linux', 'windows']) {
  for (const GOARCH of ['amd64', 'arm64']) {
    const name = `connector-${GOOS}-${GOARCH}${GOOS === 'windows' ? '.exe' : ''}`;
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
}
writeFileSync(join(root, 'bin', 'SHA256SUMS'), `${sums.join('\n')}\n`);
