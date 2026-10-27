export type ConnectorAuthentication = 'oauth' | 'bearer' | 'none';

export type ConnectorPreset = {
  readonly id: string;
  readonly name: string;
  readonly category: 'development' | 'productivity';
  readonly description: string;
  readonly url: string;
  readonly documentationUrl: string;
  readonly authentication: readonly ConnectorAuthentication[];
  readonly hint: string;
  readonly oauthRegistration?: boolean;
};

const cloudflareDocs =
  'https://developers.cloudflare.com/agents/model-context-protocol/cloudflare/servers-for-cloudflare/';

export const connectorPresets: readonly ConnectorPreset[] = [
  {
    id: 'cloudflare',
    category: 'development',
    name: 'Cloudflare',
    description: '搜索并调用 Cloudflare API，管理云端资源。',
    url: 'https://mcp.cloudflare.com/mcp',
    documentationUrl: cloudflareDocs,
    authentication: ['oauth'],
    hint: '保存后发起 OAuth，在 Cloudflare 页面选择账号与权限。',
  },
  {
    id: 'github',
    category: 'development',
    name: 'GitHub',
    description: '连接仓库、Issues、Pull Requests 与开发工作流。',
    url: 'https://api.githubcopilot.com/mcp/',
    documentationUrl:
      'https://github.com/github/github-mcp-server/blob/main/docs/host-integration.md',
    authentication: ['bearer', 'oauth'],
    oauthRegistration: true,
    hint: '可使用 PAT；OAuth 需要自行注册 GitHub App 或 OAuth App，不支持动态客户端注册。实际访问范围由 Token、组织策略和平台授权共同决定。',
  },
  {
    id: 'notion',
    category: 'productivity',
    name: 'Notion',
    description: '搜索、读取与更新工作空间中的页面和数据库。',
    url: 'https://mcp.notion.com/mcp',
    documentationUrl: 'https://developers.notion.com/guides/mcp/get-started-with-mcp',
    authentication: ['oauth'],
    hint: '保存后通过 OAuth 选择 Notion 工作空间；管理员策略可能限制客户端接入。',
  },
  {
    id: 'linear',
    category: 'productivity',
    name: 'Linear',
    description: '查询与管理团队的任务、项目和开发进度。',
    url: 'https://mcp.linear.app/mcp',
    documentationUrl: 'https://linear.app/docs/mcp',
    authentication: ['oauth', 'bearer'],
    hint: '支持 OAuth 或 API Key；多个工作空间请分别创建连接并授权。',
  },
  {
    id: 'cloudflare-docs',
    category: 'productivity',
    name: 'Cloudflare Docs',
    description: '搜索 Cloudflare 官方开发文档，无需账号授权。',
    url: 'https://docs.mcp.cloudflare.com/mcp',
    documentationUrl: cloudflareDocs,
    authentication: ['none'],
    hint: '保存后自动连接并发现目录，再将需要的工具授予 Agent。',
  },
];

export const connectorAuthenticationLabels: Readonly<Record<ConnectorAuthentication, string>> = {
  oauth: 'OAuth 授权',
  bearer: 'Token / API Key',
  none: '无需认证',
};
