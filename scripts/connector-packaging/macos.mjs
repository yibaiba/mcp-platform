import { cpSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { desktopRoot, installerRoot, metadata, run } from './common.mjs';

export function packageMacOS(stage) {
  const payload = join(stage, 'macos-payload');
  const appName = `${metadata.name}.app`;
  const app = join(payload, 'Applications', appName);
  mkdirSync(join(payload, 'Applications'), { recursive: true });
  cpSync(join(desktopRoot, 'darwin-amd64', appName), app, { recursive: true });
  const executable = (arch) =>
    join(desktopRoot, `darwin-${arch}`, appName, 'Contents/MacOS/connector-desktop');
  run('lipo', [
    '-create',
    executable('amd64'),
    executable('arm64'),
    '-output',
    join(app, 'Contents/MacOS/connector-desktop'),
  ]);
  run('codesign', ['--force', '--sign', '-', app]);
  run('codesign', ['--verify', '--deep', '--strict', app]);

  const components = join(stage, 'components.plist');
  writeFileSync(
    components,
    `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><array><dict>
<key>RootRelativeBundlePath</key><string>Applications/${appName}</string>
<key>BundleIsRelocatable</key><false/>
<key>BundleIsVersionChecked</key><true/>
<key>BundleHasStrictIdentifier</key><true/>
<key>BundleOverwriteAction</key><string>upgrade</string>
</dict></array></plist>`,
  );
  const prefix = join(installerRoot, `${metadata.slug}_${metadata.version}_macos-universal`);
  run('pkgbuild', [
    '--root',
    payload,
    '--component-plist',
    components,
    '--identifier',
    metadata.identifier,
    '--version',
    metadata.numericVersion,
    '--install-location',
    '/',
    `${prefix}.pkg`,
  ]);

  const image = join(stage, 'dmg');
  mkdirSync(image);
  cpSync(app, join(image, appName), { recursive: true });
  symlinkSync('/Applications', join(image, 'Applications'));
  run('hdiutil', [
    'create',
    '-volname',
    metadata.name,
    '-srcfolder',
    image,
    '-format',
    'UDZO',
    '-fs',
    'HFS+',
    '-ov',
    `${prefix}.dmg`,
  ]);
  return [`${prefix}.dmg`, `${prefix}.pkg`];
}
