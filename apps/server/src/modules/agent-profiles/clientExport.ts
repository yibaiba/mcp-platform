import { type ClientAuthMode, type ClientPreset } from '@platform/contracts';
export {
  clientAuthModes,
  clientPresets,
  type ClientAuthMode,
  type ClientPreset,
} from '@platform/contracts';

/**
 * Key under which the server appears in a client's config. Derived from the Agent name so two
 * Agents from this platform do not overwrite each other; non-ASCII names fall back to the id.
 */
export function clientServerName(profile: { id: string; name: string }) {
  const slug = profile.name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/, '');
  return slug || `platform-${profile.id.slice(0, 8)}`;
}

/**
 * One-click install links, only for URL-only (OAuth) configs so no secret ever lands in a link,
 * browser history or OS handler logs.
 * - Cursor: `cursor://anysphere.cursor-deeplink/mcp/install?name=$NAME&config=$BASE64_JSON`
 *   (https://cursor.com/docs/context/mcp/install-links)
 * - VS Code: `vscode:mcp/install?${encodeURIComponent(JSON.stringify({ name, ...config }))}`
 *   (https://code.visualstudio.com/api/extension-guides/ai/mcp, "Create an MCP installation URL")
 */
export function installLinks(input: { preset: ClientPreset; name: string; url: string }) {
  if (input.preset === 'cursor')
    return [
      {
        label: '添加到 Cursor',
        href: `cursor://anysphere.cursor-deeplink/mcp/install?name=${encodeURIComponent(input.name)}&config=${encodeURIComponent(Buffer.from(JSON.stringify({ url: input.url })).toString('base64'))}`,
      },
    ];
  if (input.preset === 'vscode') {
    const query = encodeURIComponent(
      JSON.stringify({ name: input.name, type: 'http', url: input.url }),
    );
    return [
      { label: '在 VS Code 中安装', href: `vscode:mcp/install?${query}` },
      { label: 'VS Code Insiders', href: `vscode-insiders:mcp/install?${query}` },
    ];
  }
  return [];
}

const oauthNote =
  '首次连接时客户端会打开浏览器：登录平台并点「允许」即可，不需要复制或保管密钥。客户端不支持浏览器授权时，改用「接入密钥」。';

export function exportClient(input: {
  preset: ClientPreset;
  url: string;
  token?: string;
  auth?: ClientAuthMode;
  name?: string;
}) {
  const name = input.name ?? 'platform';
  const auth: ClientAuthMode = input.token ? 'key' : (input.auth ?? 'key');
  const token = input.token ?? '<your-access-token>';
  const oauth = auth === 'oauth';
  const headers = oauth ? undefined : { Authorization: `Bearer ${token}` };
  const typed = { type: 'http', url: input.url, ...(headers ? { headers } : {}) };
  const plain = { url: input.url, ...(headers ? { headers } : {}) };
  const wrapped = (entry: unknown, wrapper = 'mcpServers') => ({ [wrapper]: { [name]: entry } });
  let config: unknown = wrapped(plain);
  let format = 'json';
  if (['claude-code', 'codebuddy'].includes(input.preset)) config = wrapped(typed);
  if (input.preset === 'vscode')
    config = oauth
      ? wrapped(typed, 'servers')
      : {
          ...wrapped(
            {
              ...typed,
              headers: {
                Authorization: input.token
                  ? headers!.Authorization
                  : 'Bearer ${input:platform-token}',
              },
            },
            'servers',
          ),
          ...(!input.token
            ? {
                inputs: [
                  {
                    id: 'platform-token',
                    type: 'promptString',
                    description: 'MCP Platform access token',
                    password: true,
                  },
                ],
              }
            : {}),
        };
  if (input.preset === 'generic-http') config = typed;
  if (input.preset === 'opencode') config = wrapped({ ...plain, type: 'remote' }, 'mcp');
  if (input.preset === 'cherry-studio')
    config = wrapped({
      name,
      type: 'streamableHttp',
      baseUrl: input.url,
      ...(headers ? { headers } : {}),
    });
  // Claude Desktop only launches local stdio servers from its config file: bridge with mcp-remote.
  // `Authorization:${AUTH_HEADER}` + env avoids the Windows quoting bug with spaces in args
  // (https://www.npmjs.com/package/mcp-remote).
  if (input.preset === 'claude-desktop')
    config = wrapped(
      oauth
        ? { command: 'npx', args: ['-y', 'mcp-remote', input.url] }
        : {
            command: 'npx',
            args: ['-y', 'mcp-remote', input.url, '--header', 'Authorization:${AUTH_HEADER}'],
            env: { AUTH_HEADER: `Bearer ${token}` },
          },
    );
  if (input.preset === 'codex') {
    format = 'toml';
    config = `[mcp_servers.${name}]\nurl = ${JSON.stringify(input.url)}${
      oauth
        ? ''
        : `\n${input.token ? `http_headers = { Authorization = ${JSON.stringify(headers!.Authorization)} }` : 'bearer_token_env_var = "MCP_PLATFORM_TOKEN"'}`
    }`;
  }
  const commands: Partial<Record<ClientPreset, string[]>> = {
    'claude-code': [
      'claude',
      'mcp',
      'add',
      '--transport',
      'http',
      name,
      input.url,
      ...(oauth ? [] : ['--header', `Authorization: Bearer ${token}`]),
    ],
    vscode: ['code', '--add-mcp', JSON.stringify({ name, ...typed })],
    codebuddy: ['codebuddy', 'mcp', 'add-json', '--scope', 'user', name, JSON.stringify(typed)],
    codex: [
      'codex',
      'mcp',
      'add',
      name,
      '--url',
      input.url,
      ...(oauth ? [] : ['--bearer-token-env-var', 'MCP_PLATFORM_TOKEN']),
    ],
  };
  const publicHttps = /^https:\/\/(?!localhost|127\.|\[::1\])/.test(input.url);
  const notes: Partial<Record<ClientPreset, string>> = oauth
    ? {
        'claude-code': `添加后在 Claude Code 里运行 /mcp，选择 ${name} 完成浏览器授权。`,
        codex: `添加后运行 codex mcp login ${name} 完成浏览器授权。`,
        'claude-desktop': `粘贴到 claude_desktop_config.json 的 mcpServers 并重启 Claude Desktop；mcp-remote 会打开浏览器完成授权（需要本机有 Node.js）。${
          publicHttps
            ? '平台是公网 HTTPS 地址，也可以在 Claude › 设置 › Connectors 添加自定义连接器，只填上面的地址。'
            : ''
        }`,
        windsurf: `${oauthNote} 适用于 legacy Cascade 配置。`,
        'cherry-studio': `${oauthNote} 尚未在实际客户端完成导入验收。`,
        trae: `${oauthNote} 兼容模板，尚未完成客户端验收。`,
        workbuddy: `${oauthNote} 兼容模板，尚未完成客户端验收。`,
      }
    : {
        codex:
          'CLI 从 MCP_PLATFORM_TOKEN 环境变量读取密钥，请在客户端启动环境中设置；TOML 可独立使用。',
        vscode:
          '配置用于 VS Code mcp.json；交互式 input 不会转发给 Copilot harness。CLI 使用待替换的凭证占位符。',
        'claude-desktop':
          '粘贴到 claude_desktop_config.json 的 mcpServers 并重启 Claude Desktop（需要本机有 Node.js）。密钥放在 env.AUTH_HEADER 里。',
        windsurf: '适用于官方文档中的 legacy Cascade 配置；新版客户端需另行核对。',
        'cherry-studio': '依据官方安装协议字段生成；尚未在实际客户端完成导入验收。',
        zcode: '用于设置页粘贴完整 mcpServers 配置，不是原生配置文件的 mcp.servers 结构。',
        trae: '兼容配置模板；官方页面暂时无法核对 HTTP 字段，尚未完成客户端验收。',
        workbuddy: '兼容配置模板；尚未取得可核对的独立官方 HTTP 格式，尚未完成客户端验收。',
      };
  return {
    preset: input.preset,
    auth,
    name,
    format,
    config: typeof config === 'string' ? config : JSON.stringify(config, null, 2),
    command: commands[input.preset]?.map(shellQuote).join(' '),
    notes: notes[input.preset] ?? (oauth ? oauthNote : undefined),
    links: oauth ? installLinks({ preset: input.preset, name, url: input.url }) : [],
    credential: oauth ? 'none' : input.token ? 'one-time' : 'placeholder',
  };
}
function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
