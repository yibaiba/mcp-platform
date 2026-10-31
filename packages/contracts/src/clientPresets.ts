export const clientPresets = [
  'generic-mcp-servers',
  'claude-code',
  'cursor',
  'vscode',
  'codex',
  'opencode',
  'windsurf',
  'cherry-studio',
  'codebuddy',
  'qoder',
  'trae',
  'zcode',
  'workbuddy',
  'generic-http',
  'claude-desktop',
] as const;
export type ClientPreset = (typeof clientPresets)[number];
/** How the client authenticates: browser OAuth (URL only) or a pasted access key. */
export const clientAuthModes = ['oauth', 'key'] as const;
export type ClientAuthMode = (typeof clientAuthModes)[number];
/** Human-readable names shown in the client picker; slugs stay the API identifiers. */
export const clientPresetInfo: Record<ClientPreset, { label: string; description: string }> = {
  cursor: { label: 'Cursor', description: '一键添加，首次连接时在浏览器授权' },
  vscode: { label: 'VS Code / Copilot', description: '一键安装到 VS Code 的 MCP 设置' },
  'claude-desktop': {
    label: 'Claude Desktop',
    description: '通过 mcp-remote 接入，写入 claude_desktop_config.json',
  },
  'claude-code': { label: 'Claude Code（CLI）', description: '复制一条 claude mcp add 命令' },
  codex: { label: 'Codex', description: '复制 codex mcp add 命令或 config.toml' },
  windsurf: { label: 'Windsurf', description: 'mcp_config.json 的 mcpServers' },
  opencode: { label: 'opencode', description: 'opencode 配置的 mcp 段' },
  'cherry-studio': { label: 'Cherry Studio', description: 'streamableHttp 配置' },
  codebuddy: { label: 'CodeBuddy', description: 'mcpServers 配置或 add-json 命令' },
  qoder: { label: 'Qoder', description: 'mcpServers 配置' },
  trae: { label: 'Trae', description: 'mcpServers 兼容模板' },
  zcode: { label: 'Z Code', description: '设置页粘贴完整 mcpServers' },
  workbuddy: { label: 'WorkBuddy', description: 'mcpServers 兼容模板' },
  'generic-mcp-servers': { label: '其他客户端（mcpServers JSON）', description: '通用模板' },
  'generic-http': { label: '其他客户端（单个 HTTP 服务）', description: '单服务 {type,url} 对象' },
};
/** Cards shown first; the rest stay one click away under "其他客户端". */
export const featuredClientPresets = [
  'cursor',
  'vscode',
  'claude-desktop',
  'claude-code',
  'codex',
] as const satisfies readonly ClientPreset[];
