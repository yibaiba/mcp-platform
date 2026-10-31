# 内置 Pi：配置与验证

Pi 运行时是平台工作区依赖，执行一次平台根目录的 `pnpm install --frozen-lockfile` 即安装全部依赖，默认 Docker 镜像也包含 Pi。无需全局安装 Pi CLI 或额外安装运行时。

## MCP 连接与 Agent 任务

MCP 连接、授权、工具发现和调用均不需要配置模型。选择 Pi 桥接后，平台会按需加载运行时；即使 `PI_ENABLED=false`，Pi 桥接也可直接使用。

只有执行内置 Agent 推理任务时，才需要在 `.env` 设置 `PI_ENABLED=true`、`PI_MODEL_PROVIDER`、`PI_MODEL_ID` 和模型供应商凭证，然后重启平台。Docker Compose 部署执行 `docker compose up -d server`，无需重建镜像。

运行时使用官方 `@earendil-works/pi-coding-agent@1.4.0` SDK，已包含 `@earendil-works/pi-agent-core@1.4.0`，同时提供平台所需的会话、Skills 与扩展支持；MCP 桥接使用 `pi-mcp-adapter@7.0.0`。所有版本由平台根目录的 `pnpm-lock.yaml` 统一锁定，`integrations/pi` 是平台工作区中的运行时模块。

`PI_ENABLED` 仅控制内置 Agent 任务，不控制 Pi 桥接或依赖安装。设置 `PI_ENABLED=false` 时，平台登录、直连、设备连接、Pi 桥接、统一入口、Skills 分发和文件流转继续工作。

Pi 桥接支持 Streamable HTTP、旧版 HTTP+SSE 和 stdio。远程地址可用 HTTP/HTTPS；stdio 提供启动命令、参数、环境变量和工作目录，由平台服务器（Docker 的 server 容器）执行，不在浏览器所在电脑执行。远程设备上的进程使用设备连接器。

两条执行路径：

1. **MCP 桥接**：运行会话使用独立子进程；授权目录和文件按用户、连接和授权绑定共享同一身份，由 pi-mcp-adapter 持有授权与执行。通过适配器持有的官方 MCP Client 执行程序化请求，不构造模型消息、不请求模型。完整发现工具、Prompts、Resources 和模板；转发通知、进度与原始元数据，网关照常校验权限。工具使用单次底层请求，避免高层 helper 的恢复重放。
2. **内置 Agent**：设置 `PI_MODEL_PROVIDER`、`PI_MODEL_ID` 和该供应商的环境凭证；在任务页选择配置执行真实模型推理。只注入该配置的 MCP 工具、目录/Prompt/Resource 访问工具及 Skill 版本，不继承主机的全局扩展、Skills 或内置 shell 工具。Skill 的 SKILL.md 通过 Pi loader 加载并注入任务指令；辅助文件会落盘，但不会额外授权任意宿主机文件访问或脚本执行。

`pi-mcp-adapter@7.0.0` 的公开代理原先只暴露工具。项目用 [pnpm 补丁](../patches/pi-mcp-adapter@7.0.0.patch) 增加 `getMcpClient({pi, name})`，仅返回同一扩展实例中已经连接的官方 Client，并补充嵌入接口：授权键/会话键分离、客户端能力、托管 stdio、发现元数据、按绑定串行 OAuth、平台托管 OAuth 回调和工具派发 fetch。token 过期时在工具派发前由 Pi 自身 Provider 刷新；401/403 在一次派发后明确失败，不触发 SDK 隐式重放。

补丁由 `pnpm-workspace.yaml` 和锁文件锁定，普通 frozen install 自动应用，不需要用户手工安装或修改依赖。官方 MCP SDK 2.3.1 的两个小补丁允许外部协调 OAuth，以及 timeout=0 时关闭 SDK 网络计时，避免将用户交互等待误判超时；平台仍管理执行超时和取消。升级这些依赖时须复核补丁并运行 `pnpm test`、`pnpm test:pi`。

内置 Agent 的 `platform_mcp_catalog`、`platform_mcp_prompt`、`platform_mcp_resource` 直接使用平台 ContentService，按当前配置检查 `contentIds`；资源模板仅授权匹配 URI。权限变更会取消该配置正在运行的任务。它们不经 HTTP 网关，不形成回环。

Pi OAuth 使用 `encrypted-file` store；按 pi-mcp-adapter 文档生成 `PI_MCP_ADAPTER_OAUTH_FILE_KEY`，妥善备份（32 字节密钥的 base64 表示）。凭证目录保存在持久化 DATA_DIR 下，进程之间隔离。平台 SQL 加密密钥与 Pi 文件密钥职责不同。

UI 主动发起 auth-start 后自动进入供应商页面；平台以绑定专属 HTTP 地址接收回调并交给适配器验证、交换凭证，然后发现目录并返回连接页。服务器不自行打开浏览器或另开回调监听端口。适配器的隐式自动授权保持关闭，错误明确返回；高级区域保留手工完整 redirectUrl 和 logout。logout 后读取实际 token 状态，未清除或无法读取会报错。供应商侧授权仍需供应商账户撤销。供应商的登录、刷新和撤销需使用实际账号与回调配置验证。

## 验证

`pnpm test:pi` 使用真实 Pi SDK 和适配器，对本地 MCP 服务执行发现与调用，不配置模型，进程硬超时为 60 秒。OAuth、交互、取消与权限测试由 `pnpm test` 执行，具体命令见 [测试说明](testing.md)。

工具页与任务页的用户表单和 App 宿主不要求模型。验证真实推理、权限批准后继续推理以及 Skill 辅助资源使用时，需配置模型并检查实际任务结果；验证供应商 OAuth 时需单独检查登录、刷新、撤销与重启后的凭证读取。

参考官方资料：[Pi SDK](https://pi.dev/docs/latest/sdk)、[适配器嵌入接口](https://github.com/nicobailon/pi-mcp-adapter/blob/main/docs/extension-api.md)、[OAuth](https://github.com/nicobailon/pi-mcp-adapter/blob/main/docs/auth.md)。
