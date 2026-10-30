# 客户端配置

平台提供 15 种客户端配置预设，输出当前平台的公开入口。界面用客户端名称展示（如“Cursor”“VS Code / Copilot”“Claude Desktop”），常用的 5 个以卡片列出，其余在“其他客户端”中选择。下表列出配置位置和格式来源；使用前按客户端版本检查字段，并实际连接验证。

配置里的服务名取自 Agent 名称（小写、仅 `a-z0-9-`，最长 32 字符；无法转写时用 `platform-<Agent ID 前 8 位>`），因此同一客户端接入多个 Agent 不会互相覆盖。下表中的 `<name>` 即此服务名。

## 两种认证方式

- **浏览器授权（推荐，`auth=oauth`）**：配置只含 MCP 地址，不含任何凭证。客户端首次连接收到 401 后按 MCP 授权规范发现平台、动态注册（DCR）并打开浏览器到平台的授权页，用户确认 Agent 和工具后返回客户端。动态注册接受 HTTPS、回环地址 HTTP（localhost / 127.0.0.1 / [::1]），以及私有应用 scheme（RFC 8252 §7.1，例如 Cursor 的 `cursor://anysphere.cursor-mcp/oauth/callback`）；`javascript:`、`data:`、`file:` 等保留 scheme 会被拒绝。
- **接入密钥（`auth=key`，API 默认值）**：配置带 `Authorization: Bearer <token>`，适合不支持 OAuth 的客户端或无人值守场景。

## 一键安装链接

仅在浏览器授权模式下为 Cursor 和 VS Code 生成安装链接，链接内只有服务名和地址，不会带上密钥：

- Cursor：`cursor://anysphere.cursor-deeplink/mcp/install?name=<name>&config=<base64(JSON.stringify({url}))>`。[官方文档](https://cursor.com/docs/context/mcp/install-links)
- VS Code：`vscode:mcp/install?<encodeURIComponent(JSON.stringify({name,type:"http",url}))>`，Insiders 用 `vscode-insiders:`。[官方文档](https://code.visualstudio.com/api/extension-guides/ai/mcp#create-an-mcp-installation-url)

测试会把链接解码回配置并比对；尚未在真实 Cursor / VS Code 中点击验收。

| 预设                | 生成格式、使用位置与核对来源                                                                                                                                                                                                                                                                                                          |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| generic-mcp-servers | 通用 `mcpServers.<name>.url/headers` 模板，具体客户端另行确认                                                                                                                                                                                                                                                                         |
| claude-code         | `.mcp.json` 中 `mcpServers`、`type:http`、`url/headers`；提供 `claude mcp add --transport http`。[官方文档](https://code.claude.com/docs/en/mcp)                                                                                                                                                                                      |
| cursor              | `mcpServers` 下 `url/headers`。[官方文档](https://cursor.com/docs/mcp)                                                                                                                                                                                                                                                                |
| vscode              | VS Code `mcp.json` 的 `servers`、`type:http`、`url/headers` 和密码 promptString；提供 `code --add-mcp`。input 配置不转发给 Copilot harness。[官方格式](https://code.visualstudio.com/docs/agents/reference/mcp-configuration)                                                                                                         |
| codex               | TOML `mcp_servers.<name>`、`url`、`bearer_token_env_var` 或首次密钥的 `http_headers`；CLI 使用环境变量。CLI 参数可通过 `codex mcp add --help` 查看。[官方文档](https://developers.openai.com/codex/mcp)                                                                                                                               |
| opencode            | `mcp.<name>` 的 `type:remote`、`url/headers`。[官方文档](https://opencode.ai/docs/mcp-servers/)                                                                                                                                                                                                                                       |
| windsurf            | legacy Cascade `mcp_config.json` 的 `mcpServers`、`url/headers`，当前官方文档允许 url/serverUrl；不宣称新版产品已实测。[官方文档](https://docs.devin.ai/desktop/cascade/mcp)                                                                                                                                                          |
| cherry-studio       | `type:streamableHttp`、`baseUrl/headers`；核对官方安装协议源码，原生导入入口与外层包装尚待客户端验收。[官方源码](https://github.com/CherryHQ/cherry-studio/blob/main/src/shared/data/types/mcpProtocolInstall.ts)                                                                                                                     |
| codebuddy           | `mcpServers`、`type:http`、`url/headers`；提供 `codebuddy mcp add-json --scope user`。[官方文档](https://www.codebuddy.ai/docs/cli/mcp)                                                                                                                                                                                               |
| qoder               | `mcpServers`、`url/headers`；HTTP/SSE 由客户端识别。[官方文档](https://docs.qoder.com/zh/user-guide/chat/model-context-protocol)                                                                                                                                                                                                      |
| trae                | 保留 `mcpServers` 的 `url/headers` 兼容模板；[官方页面](https://docs.trae.ai/ide/add-mcp-servers) HTTP 字段尚未核验，使用前需确认客户端支持的格式                                                                                                                                                                                     |
| zcode               | 设置页支持粘贴完整 `mcpServers`，不应将其直接当作原生 `mcp.servers` 文件结构。[官方文档](https://zcode.z.ai/en/docs/mcp-services)                                                                                                                                                                                                     |
| workbuddy           | 保留 `mcpServers` 的 `url/headers` 兼容模板；[官方站点](https://www.codebuddy.ai/docs/workbuddy/) 独立 HTTP 格式尚未核验，使用前需在 WorkBuddy 中确认，不能直接使用 CodeBuddy CLI 格式                                                                                                                                                |
| claude-desktop      | `claude_desktop_config.json` 的 `mcpServers`，通过 `npx -y mcp-remote <url>` 桥接；密钥模式加 `--header Authorization:${AUTH_HEADER}` 并在 `env.AUTH_HEADER` 放 `Bearer <token>`（避免 Windows 引号问题）。公网 HTTPS 部署也可在 Claude 的“Connectors › 添加自定义连接器”只填地址。[mcp-remote](https://github.com/geelen/mcp-remote) |
| generic-http        | 单个 `{type:"http",url,headers}` 对象，供接受单服务配置的入口使用                                                                                                                                                                                                                                                                     |

CLI 按 POSIX shell 转义；Windows 用户可使用生成的 JSON/TOML，或按 PowerShell 的转义方式调整命令。CLI 不会自动执行或写入本机客户端。Codex CLI 要求客户端启动环境包含 MCP_PLATFORM_TOKEN；普通导出的其他 CLI 仍需替换凭证占位符。

普通 `GET /profiles/:id/export?client=...&auth=oauth|key` 不读取或恢复明文密钥；`auth` 缺省为 `key`（占位符），`oauth` 返回只含地址的配置和安装链接（`links`）。`POST /profiles/:id/keys` 首次返回全部预设的完整配置，关闭密钥展示后只剩占位符导出。请求体可传 `{"replace": true}`：签发新密钥的同时撤销该 Agent 其余有效密钥，响应的 `revoked` 列出被撤销的密钥 ID；缺省不撤销。界面在已有有效密钥时会先询问“撤销旧密钥并生成”还是“保留旧密钥，再生成一把”。此行为有覆盖全部预设、跨用户拒绝、密钥替换和密钥列表脱敏的 API 测试。
