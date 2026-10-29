# 测试说明

从仓库根目录安装依赖并配置 `.env`。后端集成测试需要真实 PostgreSQL，使用 `DATABASE_URL` 指定的数据库；测试会创建临时账号并清理数据，建议使用独立测试库。Go 需在 PATH 中，`pnpm test` 会先构建本机连接器。

## 常规检查

2026-10-29 八项能力最终回归为 17 组、260 项通过，每个后端进程保留 60 秒硬超时。Node.js 22/24、原生 Linux amd64/arm64 镜像、单端口 Compose 的 REST 重启持久化与禁止重放、Python 冷/热缓存及独立 Chrome 的 Apps 隔离检查均通过。具体环境、CI 链接、初次失败与未完成的外部供应商/实机验证见[八项能力验收记录](eight-capabilities-progress.md#最终验收与合并)。

```sh
pnpm check-types
pnpm lint
pnpm build
pnpm test
pnpm test:pi
```

`pnpm test` 按当前 `scripts/test.mjs` 的功能分组顺序执行，覆盖连接、身份、工作空间、授权、交接、OAuth、Pi、协议目录、OpenAPI、交互与 Apps。每个后端测试进程由脚本强制限制为 60 秒，无自动重试。产物结果专项包含新旧 SDK 客户端、产生者授权、到期与保存期间配置失效的检查。可使用同一入口运行专项：

```sh
pnpm test tests/upstreamOAuth.test.ts tests/openapiOAuth.test.ts
pnpm test tests/connectorPresets.test.ts tests/authorizationFlow.test.ts tests/upstreamOAuth.test.ts
```

`pnpm test:pi` 通过真实 Pi SDK 和适配器对本地 MCP 服务发现与调用，不请求模型，硬超时为 60 秒。该检查需要依赖已经安装，不需要设置 `PI_ENABLED=true`。

## 内置连接器检查

`connectorPresets.test.ts` 覆盖官方预设的配置校验、认证切换后旧凭证排除、空凭证与请求头换行错误、平台与 Pi 授权响应解析，以及 Token/Client Secret 的加密保存和管理接口脱敏。authorizationFlow.test.ts 覆盖浏览器自动跳转、已授权后发现、错误显式返回且不重试。上游 OAuth 与 OpenAPI 回归核对实际回调地址、账号归属、默认与独立绑定、303 返回、拒绝重复回调及授权期间业务派发为零。

2026-10-27 在 macOS 本机 Chrome 验证了预设选择、GitHub Token/OAuth 切换、Pi 桥接选择、键盘选择与 Escape 关闭、手动添加入口，以及 390px 窄屏无页面横向溢出。通过界面保存 Cloudflare Docs 的 Pi 连接，实际连接官方远程服务并发现两个工具。此记录只覆盖公开文档服务的真实发现；未使用供应商账号完成 Cloudflare、GitHub、Notion 或 Linear 的登录、刷新、撤销，不代表这些授权流程已实机验收。

本轮授权自动化与紧凑目录变更的分组回归合计 135 项通过（新增身份检查修正测试会话上下文后，该组单独重跑通过）。类型检查、ESLint、生产构建及真实无模型 Pi 检查通过。独立源文件副本完成冻结锁文件离线安装；macOS Chrome 检查分组目录、连接状态、多账号添加入口、Escape 关闭、手工回调默认折叠和 390px 窄屏，公开 Cloudflare Docs 的 Pi 目录刷新成功。此验收不包含真实供应商账号 OAuth。

Gitee 专项覆盖远程及 stdio 配置、平台直连和 Pi 的凭证加密与管理接口脱敏、运行方式切换时的凭证排除，以及 stdio 预设识别。macOS 本机执行官方 `npx -y @gitee/mcp-gitee@latest --version` 成功，输出 `Version: 1.0.0`；官方远程服务完成匿名 MCP 初始化。未配置实际 Gitee 令牌，账号工具的发现与调用尚未验收。

## 连接列表与上手引导

`pnpm test tests/setupProgress.test.ts tests/authorizationFlow.test.ts tests/toolCatalog.test.ts tests/connectorPresets.test.ts` 本轮 22 项通过，进程硬超时保持 60 秒。上手进度检查覆盖未连接/停止、空授权 Profile、跨 Profile 或已撤销密钥，以及只有 Prompt/Resource 授权的配置。进度只表示平台设置状态，不将密钥生成当作客户端已接通。

2026-10-27 在 macOS Chrome 检查了紧凑连接行、授权弹窗、默认折叠的撤销/手工回调/OpenAPI、390px 窄屏无页面横向溢出、方向键/回车打开编辑和 Escape 关闭。从工作空间经指南能回到权限表单或客户端配置区域；包含占位凭证的真实配置复制完成后显示成功提示。已停机的本地协议服务产生真实目录连接错误，提示保留原始错误并独立于按钮布局。未重新执行供应商 OAuth、生成真实接入密钥或验证外部客户端；新密钥结果弹窗的真实签发与嵌套配置窗口尚未进行浏览器验收。

## Go 与跨平台构建

设备连接简化增加 `connect`：首次配对后直接运行，后续复用原配置。Go CLI 单元测试覆盖只配对一次、凭证不出现在输出、无效配置与不同平台明确失败、原 `pair` 不覆盖配置，以及空配对码。`tests/devices.test.ts` 新增真实进程的首次配对、上线、退出、复用配置重启和不新增设备记录；专项共 7 项通过，保持每个后端进程 60 秒硬超时。Go test/vet、类型检查、ESLint、生产构建和六架构交叉构建通过。

2026-10-27 在本机 macOS 运行真实 Go `connect`，经 `localhost:4303` 的 Vite HTTP/WebSocket 代理配对并上线，Chrome 显示真实设备及心跳；检查了“添加本机工具”预选设备/stdio、Escape 关闭和 390px 窄屏无横向溢出。验收设备随后停止并撤销。未在浏览器提交新工具配置或生成配对码；未验证远端物理电脑、Windows/Linux 自启动、实际文件/终端工具、浏览器自动化或桌面鼠标键盘。尚无 npm 启动包和三类工具自动安装功能。对应提交 `20db835` 的 Node.js 22/24 CI 已通过；这不能替代上述未完成的实机验收。

GitHub Actions 在 Node.js 22、24 和独立 PostgreSQL 上执行冻结安装、重复迁移、类型检查、ESLint、生产构建、分组后端测试、无模型 Pi 桥接与 Go test/vet；Node.js 24 任务同时交叉构建六个架构。这些 Linux CI 检查不能替代各客户端、供应商 OAuth 和物理设备验收。

```sh
cd connector
node ../scripts/check.mjs 60 go test -timeout 60s ./...
node ../scripts/check.mjs 60 go vet ./...
cd ..
node scripts/check.mjs 600 pnpm connector:build
```

交叉构建覆盖 macOS、Linux、Windows 的 amd64/arm64。设备集成测试在同机启动实际 Go 进程；两台物理设备、系统登录自启动与 Windows 进程树需要在对应环境单独验证。

## 连接器下载与安装

`pnpm test tests/connectorDistribution.test.ts tests/connectorInstaller.test.ts` 新增 13 项通过。覆盖匿名下载的实际二进制与 SHA-256、非法文件名与路径拒绝、缺少构建文件的 503、安装脚本文本、带空格目录安装、原配置保留、校验失败保留旧程序，以及脚本下载失败时命令返回非零。完整复制命令还启动真实 Go 连接器，完成配对、上线、MCP 调用、退出和复用配置重连，确认没有新增第二条设备记录。每个后端测试进程仍保持 60 秒硬超时。

2026-10-27 在本机 macOS Chrome 点击“复制安装连接命令”，将实际剪贴板内容在空安装目录运行，经 `localhost:4303` 下载、校验、配对并上线，页面显示设备。验收后停止并撤销该设备。浏览器检查 Windows 命令切换、六种手动下载入口和 390px 窄屏无横向溢出。本机地址提示明确说明其他电脑需要使用可访问的平台 HTTPS 域名。

类型检查、ESLint、生产构建、Go test/vet、六架构交叉构建以及服务端和 Web Docker 镜像构建通过。隔离 Compose 项目通过 Caddy 匿名下载两个安装脚本及六种二进制，逐个核对镜像内的 SHA-256；同时通过新库迁移、重复迁移、认证/API、Apps 隔离源及真实无模型 Pi 桥接。镜像构建验收发生在补充本机地址提示之前，最终提示已另行通过前端类型检查、生产构建和本机浏览器检查。

首次全量回归有一项 Pi stdio 测试达到 15 秒单项超时，其余 157 项通过；当时同时运行 Docker 镜像构建。构建结束后独立运行 Pi 分组，7 项通过；随后完整七组回归 158 项全部通过。没有修改或延长测试超时，尚不能据此确定最初超时的原因。

Windows PowerShell 安装脚本尚未实机运行；尝试使用官方 PowerShell Docker 镜像进行语法检查时，拉取镜像达到 300 秒命令超时，解析器未执行。远端物理电脑、远端 HTTPS 安装、Windows/Linux 的实际安装与桌面操作未验收；交叉编译和本机协议检查不代表这些环境已经可用。

## Compose

### 2026-10-28 单端口改造本地验收

在 macOS、Node.js 24.17.0、pnpm 10.12.4 和隔离 PostgreSQL 17 环境中，类型检查、ESLint、生产构建、4 项静态网页与沙箱路由测试通过。真实 Chrome 使用当前仓库的生产入口，通过两层 iframe 的不透明源及 DOM/Cookie/存储隔离、初始化、App 工具调用、全屏连续性和关闭检查。

完整后端测试为 162 项通过、1 项失败：`catalogAdapters.test.ts` 的 Pi 目录测试触发现有 15 秒用例超时，单独复测仍超时；修改前的基线单独运行该用例约 13.5 秒通过，原因尚未确定，不能记为本地全量通过。测试超时设置未放宽。镜像验收另由下述脚本和本仓库 CI 执行，本地浏览器结果不代替容器或公网环境验证。

同一应用代码在 [GitHub Actions 的 Linux 验证](https://github.com/yibaiba/mcp-platform/actions/runs/40645423794)中，Node.js 22/24 的 163 项后端测试全部通过，连同类型检查、Lint、生产构建、无模型 Pi、Go test/vet 和六架构构建。该轮镜像构建、源码一致性、迁移、网页/API 和下载校验通过，但新设备验收脚本误传 `expiresAt`，配对接口返回 400，因此该轮整体 CI 失败、未发布镜像。脚本已改为只传接口要求的 `code`；在 macOS 重新构建并实际下载运行 Go 连接器，同端口 WebSocket 上线和撤销断线检查通过。

[第二轮 CI](https://github.com/yibaiba/mcp-platform/actions/runs/40646912748)的代码检查和 amd64 容器验收全部通过，包括 Go 设备通信、Apps HTTP 契约和真实 Pi 桥接；发布时的 QEMU arm64 Go 编译触发 180 秒编译超时，统一镜像标签未发布。流水线已改为两个原生架构分别构建及验收，再合并已通过的镜像；保留原有编译和测试超时。

先从当前仓库构建应用镜像，再运行隔离的检查项目：

```sh
node scripts/check.mjs 900 docker build --target app -t mcp-platform:local .
node scripts/check.mjs 600 node scripts/verify-compose.mjs
```

需要 Docker、支持 `!override` 的 Compose，并空出回环端口 54330。脚本使用直接镜像部署文件 `docker-compose.yml`，以独立项目、临时凭证和新卷启动应用与 PostgreSQL；构建用的 `compose.yaml` 仍连接外部数据库。运行前校验镜像源码与当前仓库、镜像来源标签，再检查迁移、重复迁移、非 root 用户禁网执行 pnpm、网页与资源、认证/API、六种连接器下载文件，并实际运行本机 Go 连接器验证同端口 WebSocket 上线和撤销。Apps 同端口路由与 CSP、无模型 Pi 桥接也包含在检查内，结束后清理本次项目和卷。`PLATFORM_TEST_IMAGE` 可指定当前源码构建的本地标签。公网 DNS、证书和实际 iframe/CSP 行为需另行验证。备份与恢复流程见 [部署说明](deployment.md)。

## Apps 浏览器检查

使用独立测试数据库，在 `.env` 中启用注册，启动开发服务并保持运行。构建页面夹具，再在另一个终端启动本地 MCP 服务：

```sh
pnpm --filter web exec vite build --config test-fixtures/vite.config.ts
node scripts/check.mjs 1800 pnpm exec tsx tests/browserApps.mts
```

该服务使用 `http://127.0.0.1:54820/mcp`。安装了 Chrome 和 Playwright 的环境可在服务运行期间执行：

```sh
BROWSER_BASE_URL=http://localhost:4301 node scripts/check.mjs 180 node scripts/verify-apps-browser.mjs
```

脚本默认访问生产入口 `http://localhost:4300`，`BROWSER_BASE_URL` 可切换开发或容器验收地址；`BROWSER_FIXTURE_URL` 指定后端可访问的夹具 MCP 地址。默认导入 `playwright`，也可通过 `PLAYWRIGHT_MODULE` 指向现有模块。Playwright 不是项目依赖，需由浏览器检查环境提供。脚本检查两层 iframe 的不透明源及 DOM/Cookie/存储隔离、初始化、结果传递、app-only 调用、全屏尺寸、iframe 连续性及关闭行为，输出写入 `.data/browser-acceptance/`。

浏览器夹具使用官方 App SDK 构建，不是官方发布示例。验证官方示例、实际外部客户端、公网 Sandbox 或真实模型任务时，需分别记录实际环境和结果。OAuth 本地协议测试也不能代替供应商账号的登录、刷新、撤销及回调配置验证。

## 搜索、累计指标、管理 CLI 与结果节选

2026-10-29 最终本地后端回归为 19 组、276 项通过；类型检查、Lint、构建、Go test/vet、六架构交叉构建及真实无模型 Pi 通过。精确检索 P95 1423.7 ms 未达到 1000 ms 门槛，镜像构建受 Docker Hub TLS 超时阻塞，不能据此视为整体交付验收通过。

专项可运行 `pnpm test tests/discovery.test.ts tests/vectorSearch.test.ts`、`pnpm test tests/runtimeMetrics.test.ts tests/cliAuth.test.ts` 和 `pnpm test tests/resultPresentation.test.ts tests/apps.test.ts`。所有后端进程保留 60 秒硬超时。

搜索性能使用独立命令：

```sh
node scripts/check.mjs 600 pnpm exec tsx scripts/benchmark-discovery.mts
```

必须传入已迁移的隔离 PostgreSQL 数据库 `DATABASE_URL`。脚本创建并清理专用账号、10000 个工具、1536 维合成向量；记录各阶段 30 次热查询、P95 和 Recall@10。未满足 1000/300 ms 检索门槛、95% 召回或出现业务派发均返回非零。真实 HTTP Embedding 协议夹具不代表实际供应商推理质量。当前实现、实测数据、失败尝试与发布前未完成项见[本轮交付记录](search-cli-results-progress.md)。

## 桌面连接器迁移验收

2026-10-29 在独立仓库完成 20 组、288 项后端回归、Go test/vet、CLI 与桌面各六架构构建、七个桌面安装包及真实浏览器设备管理检查。每个后端测试进程保持 60 秒硬超时。Node.js 22/24、双架构应用镜像和 Compose，以及桌面打包 CI 均通过。环境、CI 链接、迁移与未完成的实机检查见[桌面迁移最终记录](connector-desktop.md#2026-10-29-独立仓库最终记录)。

## 本机 Web 与 SSH 迁移

使用已迁移的隔离 PostgreSQL 数据库 `DATABASE_URL`，先构建本机页面和当前系统 CLI：

```sh
node scripts/check.mjs 60 pnpm --filter web build:local
node scripts/check.mjs 60 go -C connector build -o bin/connector ./cmd/connector
node scripts/check.mjs 60 pnpm exec vitest run tests/sshAccess.test.ts
node scripts/check.mjs 60 pnpm exec tsx scripts/verify-ssh-forward.mts
node scripts/check.mjs 60 pnpm exec tsx scripts/verify-local-clients.mjs
node scripts/check.mjs 180 pnpm exec tsx scripts/verify-local-browser.mjs
```

OpenSSH 验收需要 `ssh`、`ssh-keygen`、`/usr/sbin/sshd`（可用 `SSHD_BIN` 指定）。它在临时目录生成测试密钥和独立 loopback sshd，实际反向转发 MCP 并验证断线不重放；不修改系统 SSH 服务、authorized_keys 或 known_hosts。Linux 需存在 sshd 的运行目录（CI 使用 `/run/sshd`）。

客户端验收使用已安装的 `codex` 与 `claude`，可用 `CODEX_BIN` / `CLAUDE_BIN` 指定可执行文件。只在独立临时 HOME 修改配置并调用客户端的 MCP 配置读取命令，不请求模型。浏览器验收由环境提供 Chrome 和 Playwright（`PLAYWRIGHT_MODULE` 可指定现有模块），检查离线修改、选择同步、平台写回、冲突、恢复、重新配对、375px 布局及 SSH 创建/编辑/下载/删除，截图写入 `.data/local-browser-acceptance`。不使用业务账号或业务数据库。

Windows CI 用 Windows PowerShell 5.1 执行 `scripts/verify-ssh-windows.ps1`，验证解析、原生命令参数边界、带空格私钥路径、多端口参数和退出码。该 argv 夹具不连接 SSH，不能替代真实 Windows 登录启动、远端设备网络和密钥配置验收。迁移细节见[本机管理](local-management.md)和[SSH 接入](ssh-access.md)。

## 网络与版本更新

实现与来源规则见[网络、安装源与版本更新](network-updates.md)，环境、初次失败修复和真实环境限制见[本轮交付记录](network-updates-progress.md)。测试组随功能增加，以 `scripts/test.mjs` 为准；每个后端进程硬超时仍为 60 秒。

```sh
pnpm test tests/network.test.ts tests/networkGit.test.ts tests/packageUpdates.test.ts tests/platformUpdates.test.ts
node scripts/check.mjs 60 go -C connector test -timeout 60s ./...
node scripts/check.mjs 60 go -C connector vet ./...
node scripts/check.mjs 60 pnpm --filter web build
node scripts/check.mjs 60 pnpm --filter web build:local
node scripts/check.mjs 60 go -C connector build -o bin/connector ./cmd/connector
node scripts/check.mjs 60 pnpm exec tsx scripts/verify-network-browser.mts
```

浏览器脚本需要已迁移的独立 PostgreSQL `DATABASE_URL`、Chrome 和环境提供的 Playwright（可用 `PLAYWRIGHT_MODULE` 指定），创建并清理专用账号；会写入并清理平台网络配置及平台更新单例，因此只能用于隔离验收数据库，不能连接业务数据库。它启动自己的 HTTP/npm/GitHub 协议夹具与本机 Go 管理进程，不请求模型。构建发布版本时传 `PLATFORM_RELEASE_TAG`，无 Git 的 Docker/源码归档构建传完整 `PLATFORM_COMMIT`。

## 内容库、MCPB 与分类节选

专项与当前限制见[迁入记录](mcphub-management-progress.md)和[使用说明](mcphub-management.md)。完整测试入口按功能分组，每个后端进程仍保留 60 秒硬超时。浏览器使用隔离 PostgreSQL、Chrome 和环境提供的 Playwright：

```sh
node scripts/check.mjs 60 pnpm --filter web build
node scripts/check.mjs 60 pnpm --filter web build:local
node scripts/check.mjs 60 go -C connector build -o bin/connector ./cmd/connector
node scripts/check.mjs 60 pnpm exec tsx scripts/verify-management-browser.mts
```

先完成本机页面构建，再运行 Go test/vet；不要在 Go 编译读取 embed 文件时并行重建该目录。

### MCPB 与内容引用修复验收

PR #9 最终提交 `cac29c6469162c86d24ff77bbd68f16ede1225d3` 的 [平台 CI](https://github.com/yibaiba/mcp-platform/actions/runs/40848729597) 和 [桌面 CI](https://github.com/yibaiba/mcp-platform/actions/runs/40848729589) 已通过：Node.js 22/24 各 27 组 365 项、Go test/vet、Pi、六架构 CLI、双架构镜像与 Compose，以及六架构桌面和七个安装包。

2026-10-29 本地 27 组覆盖 365 项通过；基础组排除参数修正后补跑 45 项，其余组通过。新增 `tests/bundleLifecycle.test.ts` 与 `tests/bundleLocal.test.ts` 覆盖包历史、卸载清理、同摘要重新上传、解释器约束和真实本机 HMAC/Profile/独立客户端使用链路；内容库增加删除引用与并发授权回归。Go test/vet、类型检查、Lint、生产构建、重复迁移及无模型 Pi 通过。浏览器增加历史刷新、卸载、清理、本机客户端配置及移除检查。过程和实机边界见[修复记录](mcphub-management-progress.md#缺口修复2026-10-29)。

## 工作空间界面验收

分组导航、草稿保护、当前内容预览、删除确认、连接筛选与更新状态展示见[界面优化记录](ui-polish.md)。除管理和网络浏览器脚本外，执行 `node scripts/check.mjs 60 pnpm exec tsx scripts/verify-ui-state-browser.mts` 验证加载、空记录、失败、重试、站内离开保护和手机抽屉。所有脚本仅用于隔离验收数据库。
