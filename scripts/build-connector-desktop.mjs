import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, copyFileSync, renameSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { readMetadata } from './connector-packaging/metadata.mjs';

const root = fileURLToPath(new URL('../connector/', import.meta.url));
const destination = join(root, 'bin', 'desktop');
const metadata = readMetadata();
const { name: appName, identifier, version, numericVersion } = metadata;
const artwork = join(root, 'internal', 'desktop', 'branding');
const sums = [];
execFileSync('go', ['run', './scripts/icons'], {
  cwd: root,
  env: { ...process.env, CGO_ENABLED: '0' },
  stdio: 'inherit',
  timeout: 60_000,
});
mkdirSync(destination, { recursive: true });
for (const GOOS of ['darwin', 'linux', 'windows']) {
  for (const GOARCH of ['amd64', 'arm64']) {
    const target = `${GOOS}-${GOARCH}`;
    const name = `connector-desktop-${target}${GOOS === 'windows' ? '.exe' : ''}`;
    const output = join(destination, name);
    const ldflags = [
      `-X github.com/egoist/mygo.packageIdentifier=${identifier}`,
      `-X github.com/egoist/mygo.packageVersion=${version}`,
    ];
    if (GOOS === 'windows') ldflags.push('-H=windowsgui');
    const args = ['build', '-trimpath', `-ldflags=${ldflags.join(' ')}`, '-o', output];
    args.push('./cmd/connector-desktop');
    execFileSync('go', args, {
      cwd: root,
      env: { ...process.env, GOOS, GOARCH, CGO_ENABLED: '0' },
      stdio: 'inherit',
      timeout: 180_000,
    });
    sums.push(`${createHash('sha256').update(readFileSync(output)).digest('hex')}  ${name}`);
    if (GOOS === 'darwin') {
      const contents = join(destination, target, `${appName}.app`, 'Contents');
      mkdirSync(join(contents, 'MacOS'), { recursive: true });
      mkdirSync(join(contents, 'Resources'), { recursive: true });
      const executable = join(contents, 'MacOS', 'connector-desktop');
      copyFileSync(output, `${executable}.new`);
      renameSync(`${executable}.new`, executable);
      copyFileSync(join(artwork, 'connector.icns'), join(contents, 'Resources', 'connector.icns'));
      writeFileSync(
        join(contents, 'Info.plist'),
        `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleName</key><string>${appName}</string>
<key>CFBundleDisplayName</key><string>${appName}</string>
<key>CFBundleIdentifier</key><string>${identifier}</string>
<key>CFBundleExecutable</key><string>connector-desktop</string>
<key>CFBundleIconFile</key><string>connector.icns</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>${numericVersion}</string>
<key>CFBundleShortVersionString</key><string>${numericVersion}</string>
<key>LSMinimumSystemVersion</key><string>12.0</string>
<key>NSHighResolutionCapable</key><true/>
</dict></plist>
`,
      );
    }
    if (GOOS === 'linux') {
      // The absolute executable path is chosen at installation, not at cross-build time.
      writeFileSync(
        join(destination, `connector-desktop-${target}.desktop`),
        `[Desktop Entry]
Type=Application
Name=MCP Platform Connector
Comment=Manage local MCP servers and Skills
Exec=${name}
Terminal=false
Categories=Development;
`,
      );
    }
    console.log(`Built desktop ${target}`);
  }
}
writeFileSync(join(destination, 'SHA256SUMS'), `${sums.join('\n')}\n`);
