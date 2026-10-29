import { createHash } from 'node:crypto';
import {
  accessSync,
  constants,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import {
  installerRoot,
  toolsRoot,
  platformRoot,
  metadata,
  run,
} from './connector-packaging/common.mjs';
import { packageLinux } from './connector-packaging/linux.mjs';
import { packageMacOS } from './connector-packaging/macos.mjs';
import { packageWindows } from './connector-packaging/windows.mjs';

const args = process.argv.slice(2);
if (args.some((arg) => arg !== '--skip-build' && !arg.startsWith('--targets=')))
  throw new Error('Supported options: --skip-build --targets=linux,windows,macos');
const targets = (
  args.find((arg) => arg.startsWith('--targets='))?.slice('--targets='.length) ??
  'linux,windows,macos'
).split(',');
if (targets.some((target) => !['linux', 'windows', 'macos'].includes(target)))
  throw new Error('Installer targets must be linux, windows or macos.');
if (targets.includes('macos') && process.platform !== 'darwin')
  throw new Error('macOS installer packaging requires macOS (pkgbuild/hdiutil/lipo).');
const tools = [];
if (targets.includes('linux')) tools.push(join(toolsRoot, 'nfpm'));
if (targets.includes('windows'))
  tools.push(join(toolsRoot, 'nsis', process.platform === 'darwin' ? 'mac' : 'linux', 'makensis'));
for (const file of tools) {
  try {
    accessSync(file, constants.X_OK);
  } catch {
    throw new Error(`Missing packaging tool ${file}. Run pnpm connector:installers:setup first.`);
  }
}
if (!args.includes('--skip-build'))
  run(process.execPath, [join(platformRoot, 'scripts/build-connector-desktop.mjs')], {
    timeout: 1_200_000,
  });
mkdirSync(installerRoot, { recursive: true });
const stage = mkdtempSync(join(installerRoot, '.staging-'));
try {
  const artifacts = [];
  if (targets.includes('linux')) artifacts.push(...packageLinux(stage));
  if (targets.includes('windows')) artifacts.push(...packageWindows());
  if (targets.includes('macos')) artifacts.push(...packageMacOS(stage));
  const checksums = artifacts.map(
    (file) => `${createHash('sha256').update(readFileSync(file)).digest('hex')}  ${basename(file)}`,
  );
  writeFileSync(join(installerRoot, 'SHA256SUMS'), `${checksums.join('\n')}\n`);
  console.log(
    `Packaged ${artifacts.length} installers for ${metadata.version} in ${installerRoot}`,
  );
} finally {
  rmSync(stage, { recursive: true, force: true });
}
