import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { platformRoot, toolsRoot, run } from './connector-packaging/common.mjs';

if (!['darwin', 'linux'].includes(process.platform))
  throw new Error('Packaging tools are supported on macOS and Linux amd64.');
if (process.platform === 'linux' && process.arch !== 'x64')
  throw new Error('The prebuilt Linux NSIS compiler requires amd64.');
mkdirSync(toolsRoot, { recursive: true });
run('go', ['install', 'github.com/goreleaser/nfpm/v2/cmd/nfpm@v2.47.0'], {
  cwd: platformRoot,
  env: { ...process.env, GOBIN: toolsRoot, CGO_ENABLED: '0' },
  timeout: 300_000,
});
const version = '3.0.5.0';
const response = await fetch(
  `https://github.com/electron-userland/electron-builder-binaries/releases/download/nsis-${version}/nsis-${version}.7z`,
  { signal: AbortSignal.timeout(120_000) },
);
if (!response.ok) throw new Error(`NSIS download failed: HTTP ${response.status}`);
const archive = Buffer.from(await response.arrayBuffer());
const expected = '44755ffcf6401ef358369fa80fb4351d7d0d649d8d3deda39a8d29035cbb9747';
if (createHash('sha256').update(archive).digest('hex') !== expected)
  throw new Error('NSIS archive checksum mismatch.');
const path = join(toolsRoot, `nsis-${version}.7z`);
writeFileSync(path, archive);
const nsisRoot = join(toolsRoot, 'nsis');
mkdirSync(nsisRoot, { recursive: true });
if (process.platform === 'darwin') {
  run('tar', ['-xf', path, '-C', nsisRoot], { env: { ...process.env, LC_ALL: 'C' } });
} else {
  run('7z', ['x', '-y', path, `-o${nsisRoot}`]);
}
run(
  join(nsisRoot, process.platform === 'darwin' ? 'mac/makensis' : 'linux/makensis'),
  ['-VERSION'],
  { env: { ...process.env, NSISDIR: nsisRoot } },
);
console.log(`\nPackaging tools installed in ${toolsRoot}. NSIS uses an x64 host binary.`);
