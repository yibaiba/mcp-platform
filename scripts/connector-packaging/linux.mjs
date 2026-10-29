import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import {
  connectorRoot,
  desktopRoot,
  installerRoot,
  toolsRoot,
  artworkRoot,
  metadata,
  run,
} from './common.mjs';

export function packageLinux(stage) {
  const artifacts = [];
  for (const arch of ['amd64', 'arm64']) {
    const configuration = {
      name: metadata.slug,
      arch,
      platform: 'linux',
      version: metadata.version,
      release: '1',
      maintainer: metadata.maintainer,
      homepage: metadata.homepage,
      license: metadata.license,
      section: 'utils',
      priority: 'optional',
      description: 'Native desktop connector for local MCP servers and Skills.',
      contents: [
        content(
          join(desktopRoot, `connector-desktop-linux-${arch}`),
          `/usr/bin/${metadata.slug}`,
          0o755,
        ),
        content(
          join(connectorRoot, 'packaging/linux/dev.mcplatform.connector.desktop'),
          `/usr/share/applications/${metadata.identifier}.desktop`,
        ),
        content(
          join(artworkRoot, 'connector.png'),
          `/usr/share/icons/hicolor/512x512/apps/${metadata.slug}.png`,
        ),
        content(
          join(artworkRoot, 'connector.svg'),
          `/usr/share/icons/hicolor/scalable/apps/${metadata.slug}.svg`,
        ),
      ],
      overrides: {
        deb: {
          depends: [
            'libc6 (>= 2.28)',
            'libgtk-3-0 (>= 3.22)',
            'libglib2.0-0 (>= 2.40)',
            'libayatana-appindicator3-1 | libappindicator3-1',
          ],
        },
        rpm: {
          depends: [
            'glibc >= 2.28',
            'libgtk-3.so.0()(64bit)',
            'libglib-2.0.so.0()(64bit)',
            '(libayatana-appindicator3.so.1()(64bit) or libappindicator3.so.1()(64bit))',
          ],
        },
      },
    };
    const config = join(stage, `nfpm-${arch}.json`);
    // JSON is a YAML subset accepted by nFPM; paths are encoded without interpolation.
    writeFileSync(config, JSON.stringify(configuration, null, 2));
    for (const format of ['deb', 'rpm']) {
      const platformArch = format === 'rpm' ? { amd64: 'x86_64', arm64: 'aarch64' }[arch] : arch;
      const output = join(
        installerRoot,
        `${metadata.slug}_${metadata.version}-1_${platformArch}.${format}`,
      );
      run(join(toolsRoot, 'nfpm'), [
        'pkg',
        '--config',
        config,
        '--packager',
        format,
        '--target',
        output,
      ]);
      artifacts.push(output);
    }
  }
  return artifacts;
}

function content(src, dst, mode = 0o644) {
  return { src, dst, file_info: { mode, owner: 'root', group: 'root' } };
}
