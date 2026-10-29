import { join } from 'node:path';
import {
  connectorRoot,
  desktopRoot,
  installerRoot,
  toolsRoot,
  artworkRoot,
  metadata,
  run,
} from './common.mjs';

export function packageWindows() {
  const output = join(installerRoot, `${metadata.slug}_${metadata.version}_windows-setup.exe`);
  const nsisRoot = join(toolsRoot, 'nsis');
  run(
    join(nsisRoot, process.platform === 'darwin' ? 'mac' : 'linux', 'makensis'),
    [
      '-V3',
      '-WX',
      `-DAPP_NAME=${metadata.name}`,
      `-DAPP_ID=${metadata.identifier}`,
      `-DAPP_VERSION=${metadata.version}`,
      `-DAPP_NUMERIC_VERSION=${metadata.numericVersion}`,
      `-DPAYLOAD_DIR=${desktopRoot}`,
      `-DAPP_ICON=${join(artworkRoot, 'connector.ico')}`,
      `-DOUTPUT_FILE=${output}`,
      join(connectorRoot, 'packaging/windows/installer.nsi'),
    ],
    // NSIS crashes while decoding UTF-8 scripts if given Linux's C.UTF-8 on macOS.
    {
      env: {
        ...process.env,
        NSISDIR: nsisRoot,
        LC_ALL: process.platform === 'darwin' ? 'en_US.UTF-8' : 'C.UTF-8',
      },
    },
  );
  return [output];
}
