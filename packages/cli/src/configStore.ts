import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir, platform, userInfo } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
export const platformUrl = z.url().refine((raw) => {
  const url = new URL(raw);
  return (
    ['http:', 'https:'].includes(url.protocol) &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash &&
    url.pathname === '/'
  );
}, '平台地址必须为不含凭证、路径或查询参数的 HTTP(S) 源');
const credentials = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  expiresAt: z.number(),
  grantId: z.string(),
  scope: z.string(),
});
const configSchema = z.object({
  current: z.string().optional(),
  environments: z.record(
    z.string(),
    z.object({ url: platformUrl, credentials: credentials.optional() }),
  ),
});
export type CliConfig = z.infer<typeof configSchema>;
export type Credentials = z.infer<typeof credentials>;
export function configDirectory(env: NodeJS.ProcessEnv) {
  if (env.MCP_PLATFORM_CONFIG_DIR) return env.MCP_PLATFORM_CONFIG_DIR;
  if (platform() === 'win32')
    return join(env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'mcp-platform');
  if (platform() === 'darwin')
    return join(homedir(), 'Library', 'Application Support', 'mcp-platform');
  return join(env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'mcp-platform');
}
async function protect(path: string, mode: number) {
  if (platform() === 'win32')
    await promisify(execFile)('icacls', [
      path,
      '/inheritance:r',
      '/grant:r',
      `${userInfo().username}:(F)`,
    ]);
  else await chmod(path, mode);
}
export class ConfigStore {
  constructor(private readonly directory: string) {}
  async read(): Promise<CliConfig> {
    try {
      return configSchema.parse(
        JSON.parse(await readFile(join(this.directory, 'config.json'), 'utf8')),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { environments: {} };
      throw error;
    }
  }
  async write(config: CliConfig) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await protect(this.directory, 0o700);
    const temporary = join(this.directory, `${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(configSchema.parse(config), null, 2), {
      mode: 0o600,
      flag: 'wx',
    });
    await protect(temporary, 0o600);
    await rename(temporary, join(this.directory, 'config.json'));
  }
}
