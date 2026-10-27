# 内置连接器

在“连接”页的“内置连接器”中选择服务，填写名称和认证信息后保存。预设使用官方远程 MCP 地址，可选择平台直连或 Pi 桥接，两者均不需要在设备上安装程序，也不需要模型。Pi 桥接复用已有 Pi MCP 管理能力，支持服务允许的动态 OAuth 客户端注册、授权与刷新。

| 服务            | 认证                        | 官方说明                                                                                                                      |
| --------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Cloudflare      | OAuth，授权时选择账号和权限 | [Cloudflare MCP](https://developers.cloudflare.com/agents/model-context-protocol/cloudflare/servers-for-cloudflare/)          |
| GitHub          | PAT 或预注册应用的 OAuth    | [GitHub 接入说明](https://github.com/github/github-mcp-server/blob/main/docs/host-integration.md)                             |
| Notion          | OAuth，选择工作空间         | [Notion MCP](https://developers.notion.com/guides/mcp/get-started-with-mcp)                                                   |
| Linear          | OAuth 或 API Key            | [Linear MCP](https://linear.app/docs/mcp)                                                                                     |
| Cloudflare Docs | 无需认证                    | [Cloudflare 官方服务目录](https://developers.cloudflare.com/agents/model-context-protocol/cloudflare/servers-for-cloudflare/) |

保存只创建连接配置。OAuth 服务需要点击“发起授权”，打开供应商页面并确认权限；完成后回到连接页，点击“连接 / 刷新目录”。Token 服务与公开文档服务可直接发现目录。上游错误会直接显示，不会改用其他连接或身份。

GitHub 不支持动态客户端注册。使用 OAuth 时，需提供自己注册的 GitHub App 或 OAuth App 的 Client ID 和 Client Secret。保存后展开“上游授权绑定”，点击“授权状态”获取完整回调地址，先在 GitHub 应用设置中登记，再发起授权。回调地址由服务端 `PUBLIC_URL` 生成；公网部署需配置可达的地址。独立身份使用绑定对应的回调地址，不能沿用默认身份的回调地址。PAT 的资源范围、组织审批和过期时间仍由 GitHub 管理。

以上回调步骤适用于平台直连。Pi 桥接的授权与回调由适配器管理，发起授权后可在结果中查看 Pi 回调地址；预注册应用需登记该地址。远程部署时可使用“完成授权”粘贴完整回调 URL。Pi 同样不能替 GitHub 动态注册应用；适配器自带的 GitHub 快捷配置使用 GitHub CLI 已登录的 Token，本平台预设使用用户明确配置的凭证。

Token、Client Secret 通过现有连接接口加密保存，不进入预设、连接列表或浏览器持久存储。切换认证方式后只提交当前方式的凭证。预设不创建供应商账号，也不自动给 Agent 授权。

发现工具后，在 Agent 工作空间选择所需工具与连接身份。沿用连接账号、Agent 专属身份、按调用凭证隔离继续使用已有规则；选择独立身份后需要为该身份另行配置凭证或授权。多个账号或工作空间可分别添加同一种连接器，工具保留各自的稳定标识。

需要调整执行设备、地址、请求头或高级 OAuth 配置时，使用现有“添加连接”或保存后的“编辑”。官方服务的准入、供应商授权和实际工具可用性以真实连接结果为准。自动化测试覆盖配置与加密保存，不能替代供应商账号的 OAuth、刷新与撤销验收。
