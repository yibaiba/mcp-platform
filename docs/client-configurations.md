# 客户端配置

平台提供 14 种客户端配置预设，输出当前平台的公开入口。下表列出配置位置和格式来源；使用前按客户端版本检查字段，并实际连接验证。

| 预设                | 生成格式、使用位置与核对来源                                                                                                                                                                                                  |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| generic-mcp-servers | 通用 `mcpServers.platform.url/headers` 模板，具体客户端另行确认                                                                                                                                                               |
| claude-code         | `.mcp.json` 中 `mcpServers`、`type:http`、`url/headers`；提供 `claude mcp add --transport http`。[官方文档](https://code.claude.com/docs/en/mcp)                                                                              |
| cursor              | `mcpServers` 下 `url/headers`。[官方文档](https://cursor.com/docs/mcp)                                                                                                                                                        |
| vscode              | VS Code `mcp.json` 的 `servers`、`type:http`、`url/headers` 和密码 promptString；提供 `code --add-mcp`。input 配置不转发给 Copilot harness。[官方格式](https://code.visualstudio.com/docs/agents/reference/mcp-configuration) |
| codex               | TOML `mcp_servers.platform`、`url`、`bearer_token_env_var` 或首次密钥的 `http_headers`；CLI 使用环境变量。CLI 参数可通过 `codex mcp add --help` 查看。[官方文档](https://developers.openai.com/codex/mcp)                     |
| opencode            | `mcp.platform` 的 `type:remote`、`url/headers`。[官方文档](https://opencode.ai/docs/mcp-servers/)                                                                                                                             |
| windsurf            | legacy Cascade `mcp_config.json` 的 `mcpServers`、`url/headers`，当前官方文档允许 url/serverUrl；不宣称新版产品已实测。[官方文档](https://docs.devin.ai/desktop/cascade/mcp)                                                  |
| cherry-studio       | `type:streamableHttp`、`baseUrl/headers`；核对官方安装协议源码，原生导入入口与外层包装尚待客户端验收。[官方源码](https://github.com/CherryHQ/cherry-studio/blob/main/src/shared/data/types/mcpProtocolInstall.ts)             |
| codebuddy           | `mcpServers`、`type:http`、`url/headers`；提供 `codebuddy mcp add-json --scope user`。[官方文档](https://www.codebuddy.ai/docs/cli/mcp)                                                                                       |
| qoder               | `mcpServers`、`url/headers`；HTTP/SSE 由客户端识别。[官方文档](https://docs.qoder.com/zh/user-guide/chat/model-context-protocol)                                                                                              |
| trae                | 保留 `mcpServers` 的 `url/headers` 兼容模板；[官方页面](https://docs.trae.ai/ide/add-mcp-servers) HTTP 字段尚未核验，使用前需确认客户端支持的格式                                                                             |
| zcode               | 设置页支持粘贴完整 `mcpServers`，不应将其直接当作原生 `mcp.servers` 文件结构。[官方文档](https://zcode.z.ai/en/docs/mcp-services)                                                                                             |
| workbuddy           | 保留 `mcpServers` 的 `url/headers` 兼容模板；[官方站点](https://www.codebuddy.ai/docs/workbuddy/) 独立 HTTP 格式尚未核验，使用前需在 WorkBuddy 中确认，不能直接使用 CodeBuddy CLI 格式                                        |
| generic-http        | 单个 `{type:"http",url,headers}` 对象，供接受单服务配置的入口使用                                                                                                                                                             |

CLI 按 POSIX shell 转义；Windows 用户可使用生成的 JSON/TOML，或按 PowerShell 的转义方式调整命令。CLI 不会自动执行或写入本机客户端。Codex CLI 要求客户端启动环境包含 MCP_PLATFORM_TOKEN；普通导出的其他 CLI 仍需替换凭证占位符。

普通 `GET /profiles/:id/export?client=...` 不读取或恢复明文密钥。`POST /profiles/:id/keys` 首次返回全部预设的完整配置，关闭密钥展示后只剩占位符导出。此行为有覆盖全部预设、跨用户拒绝和密钥列表脱敏的 API 测试。
