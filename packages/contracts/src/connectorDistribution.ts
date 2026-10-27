export const connectorTargets = [
  { os: 'darwin', arch: 'arm64', label: 'macOS · Apple 芯片', filename: 'connector-darwin-arm64' },
  { os: 'darwin', arch: 'amd64', label: 'macOS · Intel', filename: 'connector-darwin-amd64' },
  { os: 'linux', arch: 'amd64', label: 'Linux · x64', filename: 'connector-linux-amd64' },
  { os: 'linux', arch: 'arm64', label: 'Linux · ARM64', filename: 'connector-linux-arm64' },
  { os: 'windows', arch: 'amd64', label: 'Windows · x64', filename: 'connector-windows-amd64.exe' },
  {
    os: 'windows',
    arch: 'arm64',
    label: 'Windows · ARM64',
    filename: 'connector-windows-arm64.exe',
  },
] as const;
