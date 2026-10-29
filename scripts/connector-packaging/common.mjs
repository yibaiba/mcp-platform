import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { readMetadata } from './metadata.mjs';

export const platformRoot = fileURLToPath(new URL('../../', import.meta.url));
export const connectorRoot = join(platformRoot, 'connector');
export const desktopRoot = join(connectorRoot, 'bin', 'desktop');
export const installerRoot = join(connectorRoot, 'bin', 'installers');
export const toolsRoot = join(connectorRoot, 'bin', 'tools');
export const artworkRoot = join(connectorRoot, 'internal', 'desktop', 'branding');
export const metadata = readMetadata();

export function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: platformRoot,
    stdio: 'inherit',
    timeout: 180_000,
    ...options,
  });
}
