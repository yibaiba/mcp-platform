# 内置连接器

在“连接”页的“内置连接器”中选择服务，填写名称和认证信息后保存。远程预设使用官方 MCP 地址，可选择平台直连或 Pi 桥接，无需安装服务，也不需要模型。Gitee 另外提供由平台主机执行的 stdio 预设，需要 Node.js / npx 和 npm 网络访问。Pi 桥接复用已有 Pi MCP 管理能力，支持服务允许的动态 OAuth 客户端注册、授权与刷新。

| 服务            | 认证                                         | 官方说明                                                                                                                      |
| --------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Cloudflare      | OAuth，授权时选择账号和权限                  | [Cloudflare MCP](https://developers.cloudflare.com/agents/model-context-protocol/cloudflare/servers-for-cloudflare/)          |
| GitHub          | PAT 或预注册应用的 OAuth                     | [GitHub 接入说明](https://github.com/github/github-mcp-server/blob/main/docs/host-integration.md)                             |
| Gitee           | 个人访问令牌（HTTP 请求头 / stdio 环境变量） | [Gitee MCP Server](https://help.gitee.com/ai-productivity/mcp-server)                                                         |
| Notion          | OAuth，选择工作空间                          | [Notion MCP](https://developers.notion.com/guides/mcp/get-started-with-mcp)                                                   |
| Linear          | OAuth 或 API Key                             | [Linear MCP](https://linear.app/docs/mcp)                                                                                     |
| Cloudflare Docs | 无需认证                                     | [Cloudflare 官方服务目录](https://developers.cloudflare.com/agents/model-context-protocol/cloudflare/servers-for-cloudflare/) |

目录按分类显示紧凑条目，包括图标、名称、一行说明和“添加 / 管理 / 已连接”。名称链接至官方文档，完整配置在添加表单和连接详情中展示。已有服务的菜单可以管理各条连接或添加另一个账号。分类、地址和认证方式统一由预设元数据声明。

OAuth 连接保存后自动进入供应商授权页面，用户确认账号与权限后，平台接收回调、更新身份状态、发现工具并返回对应连接。已有连接点击“发起授权”使用相同流程。Token 和免认证连接保存后直接发现目录，不需要模型。发现仅查询目录，不执行业务工具；上游错误直接显示，不会改用其他连接或身份。

GitHub 不支持动态客户端注册。使用 OAuth 时，需提供自己注册的 GitHub App 或 OAuth App 的 Client ID 和 Client Secret。保存后展开“上游授权绑定”，点击“授权状态”获取完整回调地址，先在 GitHub 应用设置中登记，再发起授权。回调地址由服务端 `PUBLIC_URL` 生成；公网部署需配置可达的地址。独立身份使用绑定对应的回调地址，不能沿用默认身份的回调地址。PAT 的资源范围、组织审批和过期时间仍由 GitHub 管理。

平台直连和 Pi 桥接均使用平台的 HTTP 回调地址，独立绑定使用各自地址。Pi 仍持有凭证并执行授权校验；平台负责浏览器跳转和接收回调，不在服务器另开本机回调端口。远程部署需正确设置 PUBLIC_URL 和 WEB_ORIGIN。手动完整回调 URL 与原始响应收在高级区域，仅在自动回调不可用或诊断时使用。Pi 同样不能替 GitHub 注册应用；本平台预设使用用户明确配置的凭证。

Token、Client Secret 通过现有连接接口加密保存，不进入预设、连接列表或浏览器持久存储。切换认证方式后只提交当前方式的凭证。预设不创建供应商账号，也不自动给 Agent 授权。

Gitee 支持两种运行方式，均可使用平台直连或 Pi 桥接：

- 官方远程服务：`https://api.gitee.com/mcp`，令牌通过 Bearer 请求头发送，无需安装服务。
- 本地进程：自动配置 `command: npx`、`args: ["-y", "@gitee/mcp-gitee@latest"]`，通过 `GITEE_ACCESS_TOKEN` 环境变量传入令牌，并将其声明为独立身份凭证字段。此配置与官方 Cursor 安装链接内的 stdio 配置等价。程序在平台主机或 server 容器执行，需要 npx 和 npm 网络访问；首次启动会安装包，使用官方配置的 latest 版本。

令牌在 [Gitee 私人令牌设置](https://gitee.com/profile/personal_access_tokens)中创建；保存后自动发现目录，再到 Agent 工作空间选择权限。切换运行方式只提交对应的请求头或环境变量，不将令牌放进命令参数。本预设不提供官方文档未声明的 OAuth。自建实例或设备上的 stdio 进程可通过“添加连接”配置 `GITEE_API_BASE`、`GITEE_ACCESS_TOKEN` 和对应的凭证环境变量声明。

发现工具后，在 Agent 工作空间选择所需工具与连接身份。沿用连接账号、Agent 专属身份、按调用凭证隔离继续使用已有规则；选择独立身份后需要为该身份另行配置凭证或授权。多个账号或工作空间可分别添加同一种连接器，工具保留各自的稳定标识。

需要调整执行设备、地址、请求头或高级 OAuth 配置时，使用现有“添加连接”或保存后的“编辑”。官方服务的准入、供应商授权和实际工具可用性以真实连接结果为准。自动化测试覆盖配置与加密保存，不能替代供应商账号的 OAuth、刷新与撤销验收。
