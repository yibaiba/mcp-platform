import { type ClientPreset } from '@platform/contracts';
export { clientPresets, type ClientPreset } from '@platform/contracts';
export function exportClient(input: { preset: ClientPreset; url: string; token?: string }) {
  const name = 'platform';
  const token = input.token ?? '<your-access-token>';
  const headers = { Authorization: `Bearer ${token}` };
  const typed = { type: 'http', url: input.url, headers };
  const plain = { url: input.url, headers };
  const wrapped = (entry: unknown, wrapper = 'mcpServers') => ({ [wrapper]: { [name]: entry } });
  let config: unknown = wrapped(plain);
  let format = 'json';
  if (['claude-code', 'codebuddy'].includes(input.preset)) config = wrapped(typed);
  if (input.preset === 'vscode')
    config = {
      ...wrapped(
        {
          ...typed,
          headers: {
            Authorization: input.token ? headers.Authorization : 'Bearer ${input:platform-token}',
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
    config = wrapped({ name, type: 'streamableHttp', baseUrl: input.url, headers });
  if (input.preset === 'codex') {
    format = 'toml';
    config = `[mcp_servers.platform]\nurl = ${JSON.stringify(input.url)}\n${input.token ? `http_headers = { Authorization = ${JSON.stringify(headers.Authorization)} }` : 'bearer_token_env_var = "MCP_PLATFORM_TOKEN"'}`;
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
      '--header',
      `Authorization: Bearer ${token}`,
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
      '--bearer-token-env-var',
      'MCP_PLATFORM_TOKEN',
    ],
  };
  const notes: Partial<Record<ClientPreset, string>> = {
    codex:
      'CLI 从 MCP_PLATFORM_TOKEN 环境变量读取密钥，请在客户端启动环境中设置；TOML 可独立使用。',
    vscode:
      '配置用于 VS Code mcp.json；交互式 input 不会转发给 Copilot harness。CLI 使用待替换的凭证占位符。',
    windsurf: '适用于官方文档中的 legacy Cascade 配置；新版客户端需另行核对。',
    'cherry-studio': '依据官方安装协议字段生成；尚未在实际客户端完成导入验收。',
    zcode: '用于设置页粘贴完整 mcpServers 配置，不是原生配置文件的 mcp.servers 结构。',
    trae: '兼容配置模板；官方页面暂时无法核对 HTTP 字段，尚未完成客户端验收。',
    workbuddy: '兼容配置模板；尚未取得可核对的独立官方 HTTP 格式，尚未完成客户端验收。',
  };
  return {
    preset: input.preset,
    format,
    config: typeof config === 'string' ? config : JSON.stringify(config, null, 2),
    command: commands[input.preset]?.map(shellQuote).join(' '),
    notes: notes[input.preset],
    credential: input.token ? 'one-time' : 'placeholder',
  };
}
function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
