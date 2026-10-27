export type InstallerPlatform = 'unix' | 'windows';

export function installerCommand(origin: string, platform: InstallerPlatform) {
  const server = new URL(origin).origin;
  if (platform === 'windows') {
    const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
    const url = quote(`${server}/api/v1/connector/install.ps1`);
    return `& ([scriptblock]::Create((Invoke-WebRequest -UseBasicParsing -Uri ${url}).Content)) -Server ${quote(server)}`;
  }
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  return `(mcp_installer=$(mktemp) && trap 'rm -f "$mcp_installer"' EXIT && curl -fsS ${quote(`${server}/api/v1/connector/install.sh`)} -o "$mcp_installer" && sh "$mcp_installer" --server ${quote(server)})`;
}
