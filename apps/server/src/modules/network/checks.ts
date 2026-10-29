import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { githubTarget } from '@platform/network';
import type { NetworkService } from './service.js';
const execute = promisify(execFile);
export async function checkNetwork(service: Pick<NetworkService, 'snapshot' | 'git' | 'fetch'>) {
  const { config } = await service.snapshot();
  const api = 'https://api.github.com/repos/yibaiba/mcp-platform';
  const download = 'https://raw.githubusercontent.com/yibaiba/mcp-platform/main/README.md';
  const clone = await service.git('https://github.com/yibaiba/mcp-platform.git');
  const http = async (url: string) => {
    const response = await service.fetch(url, {
      method: 'HEAD',
      signal: AbortSignal.timeout(15_000),
    });
    await response.body?.cancel();
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return `HTTP ${response.status}`;
  };
  const checks = [
    { kind: 'api', url: githubTarget(new URL(api), config).url.href, run: () => http(api) },
    {
      kind: 'download',
      url: githubTarget(new URL(download), config).url.href,
      run: () => http(download),
    },
    {
      kind: 'git',
      url: clone.url,
      run: async () => {
        const { stdout } = await execute(
          'git',
          ['-c', 'http.followRedirects=false', 'ls-remote', '--', clone.url, 'HEAD'],
          { timeout: 15_000, env: gitEnvironment(clone) },
        );
        if (!/^[a-f0-9]{40,64}\s+HEAD$/m.test(stdout)) throw new Error('Git 未返回有效 HEAD');
        return 'Git 访问成功';
      },
    },
  ];
  return Promise.all(
    checks.map(async ({ kind, url, run }) => {
      try {
        return { kind, url, ok: true, detail: await run() };
      } catch (error) {
        return {
          kind,
          url,
          ok: false,
          detail:
            error instanceof Error && /^HTTP \d+$/.test(error.message)
              ? error.message
              : '连接失败，请核对代理、端点、凭证和证书',
        };
      }
    }),
  );
}
export function gitEnvironment(target: {
  url: string;
  env: Record<string, string>;
  token?: string;
}) {
  return {
    PATH: process.env.PATH,
    ...target.env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    ...(target.token
      ? {
          GIT_CONFIG_COUNT: '1',
          GIT_CONFIG_KEY_0: `http.${target.url}.extraHeader`,
          GIT_CONFIG_VALUE_0: `Authorization: Bearer ${target.token}`,
        }
      : {}),
  };
}
