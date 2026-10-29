# MCP Platform

中文、自托管工具与设备管理平台。Pi 运行时随平台依赖一起安装；MCP 连接（包括 Pi 桥接）无需启用内置 Agent 或配置模型。使用 Better-T-Stack 脚手架、React/Vite、shadcn/ui（Base UI）、Hono、PostgreSQL/Drizzle、Better Auth；Go 连接器主动连接平台。

依赖、锁文件、环境配置、数据库迁移、测试和部署均位于仓库根目录内。

## 本地启动

要求 Node.js 22.19+、pnpm **10.12.4**、PostgreSQL 17；构建设备连接器需要 Go 1.27.3+。

```sh
git clone https://github.com/yibaiba/mcp-platform.git
cd mcp-platform
corepack pnpm@10.12.4 install --frozen-lockfile
cp .env.example .env
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

把第一次输出填入 `.env` 的 `BETTER_AUTH_SECRET`，第二次输出填入 `ENCRYPTION_KEY`；再独立运行一次 Base64 生成命令，将新输出填入必填的 `DEVICE_AUTH_ENCRYPTION_KEY`，分别保护和备份两把加密密钥。填写真实 `DATABASE_URL`。第一次注册时临时设置 `ALLOW_REGISTRATION=true`；创建个人账号后改回 `false` 并重启服务。不会生成默认管理员或共享密码。

```sh
pnpm db:migrate
pnpm connector:build # 平台管理员构建六种设备安装包；需要 Go 1.27.3+
pnpm dev
```

开发管理界面 <http://localhost:4301>，API 和 Apps 资源 <http://localhost:4300>；Apps 使用 `/_apps/*` 路由。在“MCP 连接”添加内置服务账号，或使用“添加连接”选择平台直连、Pi 桥接或设备连接器；自定义连接保存后点击“连接”，已连接服务通过“更多操作”刷新目录，再到“工具目录”实际调用。页面的“使用指南”提供从服务授权、Agent 权限到客户端配置的完整入口，详见[首次接入说明](docs/getting-started.md)。也可展开 OpenAPI 导入，预览并选择操作发布。stdio 命令在所选执行位置运行：平台直连/Pi 使用平台主机（Docker 的 server 容器），设备连接器使用所选设备。服务返回错误会直接展示；连接配置中的请求头和环境变量加密保存在数据库，不在列表中返回。

开发启动从仓库根目录 `.env` 读取配置，不依赖工作目录。`pnpm build` 验证后端编译并产出前端静态文件，生产使用 `NODE_ENV=production pnpm start`，由后端在 4300 同时提供网页、API、MCP、WebSocket 和 Apps。后端使用 `tsx` 源码入口，以支持按需加载内置 Pi 运行时；不要直接运行 `apps/server/dist`。

直接部署使用 `docker-compose.yml` 和 `.env.docker.example`，从 `ghcr.io/yibaiba/mcp-platform` 拉取本仓库发布的应用镜像，同时启动 PostgreSQL，仅映射应用端口 4300。源码构建使用 `compose.yaml`，构建同一个应用镜像，通过 `DATABASE_URL` 连接外部 PostgreSQL。启动、镜像发布和备份步骤见[部署说明](docs/deployment.md)。

目标电脑无需构建项目或预装 `connector`。在设备页复制安装连接命令，自动下载对应系统/架构的二进制并校验后配对；Docker 服务端镜像自带六种安装文件。其他电脑需使用可访问的平台 HTTPS 地址，详见[设备安装说明](docs/connector.md)。

## 已实现

- 登录和用户隔离；MCP 工具、Prompts、Resources 和资源模板的发现、调用/读取、独立授权与目录变更通知；停止、错误诊断和稳定标识。
- Go 0.3.0 WSS HMAC-SHA256 挑战应答、配对、重配、撤销、自动重连、关联请求、取消、断线结果未知；本地 stdio、HTTP/SSE 和托管进程。
- Agent 配置按工具、Prompt/Resource/模板、Skill 版本、产物 ID 授权；同一 `/mcp/:profileId` 入口汇聚所有适配器；接入密钥和 OAuth PKCE。
- MCP 2026-07-28 与旧会话协议双栈；完整元数据、进度和资源订阅；严格 Schema 校验，不自动重放工具调用。
- 上游 OAuth 凭证加密、刷新、重启恢复和本地撤销；独立的可选 Pi 桥接和模型任务入口。
- Skills ZIP/固定 Git commit 导入、内容哈希不可变版本、工具依赖检查、设备分发、指定版本回滚和本地修改冲突保护。
- 文件流式上传/下载、SHA-256 校验、设备间转交；Agent 通过同一配置授权的下载接口获取结果。
- `mcpServers` 配置预览与导入；OAuth 凭证需单独授权。
- 内置 Cloudflare、GitHub、Notion、Linear 与 Cloudflare Docs 官方远程 MCP 预设，提供 Token 配置与 OAuth 授权入口；[使用说明](docs/builtin-connectors.md)。
- 分身份授权绑定、按入口/客户端能力隔离的运行会话和目录快照、显式动态请求头转发；账号间不共享 Cookie。
- 托管进程树退出、按需启动、闲置休眠、健康检查和显式恢复；默认不开启休眠、探测或恢复。
- 14 种客户端配置导出、适用的 CLI 命令、上游服务说明与配置说明透传。
- OpenAPI 3.0/3.1 JSON/YAML 导入、操作预览、参数/认证组合、文件产物流转和真实 HTTP 执行。
- Form/URL Elicitation、新旧协议转换；外部 Apps 转发和工具页/Pi 任务页的官方 AppBridge 宿主。
- Agent 工作空间：逐连接选择身份与执行设备，独立 OAuth/固定凭证/stdio 凭证变量，以当前 Agent 权限发现和测试。
- 用户审批的临时权限：可申请目录、子集审批、凭证或任务作用域、到期与撤销；审批不执行业务调用，Pi 更新工具集后发起新调用。
- 持久任务快照、输出检查点和调用诊断；用户选定摘要与产物的交接，保存与执行分离，重复执行不创建第二个任务。
- 工具目录按连接、设备和实际 Agent 权限筛选，显示执行位置与身份归属；从 Agent 或工具直达调用记录，按名称筛选并查看阶段、耗时与关联标识。目录筛选和调用详情地址可保存、刷新与分享给同账号使用。
- 外部 Agent 工具说明包含连接、设备及身份方式；MCP 可列出授权产物并按字节读取文本或二进制，不要求内置模型。接入边界见[外部 Agent 接入与隔离](docs/external-agents.md)。

桌面连接器支持原生窗口、托盘、本机 MCP/Skills 管理及六架构安装包，使用方式见[桌面端说明](docs/connector-desktop.md)。CLI 也可用 `connector manage` 打开[独立本机管理页](docs/local-management.md)，无需配对。已有 HTTP MCP 可通过[SSH 反向转发接入](docs/ssh-access.md)，设备页提供绑定及 Windows 连接包。

## 验证

```sh
pnpm check-types
pnpm lint
pnpm build
pnpm test                   # 使用真实 PostgreSQL；七组顺序执行，每个进程硬超时 60 秒
cd connector
go test -timeout 60s ./...
go vet ./...
cd ..
pnpm connector:build        # macOS/Linux/Windows，amd64/arm64
pnpm test:pi                # 真实 Pi SDK 桥接；不调用模型，硬超时 60 秒
```

测试创建临时账号并清理，只使用 `.env` 指定的数据库；建议使用独立测试库。设备集成测试在同一台机器启动两个真实 Go 进程，不代表两台实机已验收。测试夹具只用于自动化验证，不参与产品运行。

## 文档

- [首次接入与使用指南](docs/getting-started.md)
- [部署与备份恢复](docs/deployment.md)
- [设备连接器与三平台自启动](docs/connector.md)
- [接口、权限与协议](docs/api.md)
- [内置 Pi 配置](docs/pi.md)
- [测试说明](docs/testing.md)
- [Agent 工作空间、权限与交接](docs/workspaces.md)
- [身份、生命周期、OpenAPI、交互与 Apps](docs/capabilities.md)
- [客户端配置格式与核对来源](docs/client-configurations.md)

依赖版本由 `pnpm-lock.yaml` 锁定。

Python 环境、统一调用预算和逐连接恢复设置见[连接稳定性](docs/connection-reliability.md)，本仓库的分阶段迁移状态见[八项能力记录](docs/eight-capabilities-progress.md)。

目录展示和声明式模板参见[目录与配置模板](docs/catalog-and-templates.md)。
市场、发现及 REST 参见[服务市场、智能发现与 REST](docs/market-discovery-rest.md)。
