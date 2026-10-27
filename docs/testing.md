# 测试说明

从仓库根目录安装依赖并配置 `.env`。后端集成测试需要真实 PostgreSQL，使用 `DATABASE_URL` 指定的数据库；测试会创建临时账号并清理数据，建议使用独立测试库。Go 需在 PATH 中，`pnpm test` 会先构建本机连接器。

## 常规检查

```sh
pnpm check-types
pnpm lint
pnpm build
pnpm test
pnpm test:pi
```

`pnpm test` 分七组顺序执行，覆盖连接、身份、工作空间、授权、交接、OAuth、Pi、协议目录、OpenAPI、交互与 Apps。每个后端测试进程由脚本强制限制为 60 秒，无自动重试。产物结果专项包含新旧 SDK 客户端、产生者授权、到期与保存期间配置失效的检查。可使用同一入口运行专项：

```sh
pnpm test tests/upstreamOAuth.test.ts tests/openapiOAuth.test.ts
pnpm test tests/connectorPresets.test.ts tests/authorizationFlow.test.ts tests/upstreamOAuth.test.ts
```

`pnpm test:pi` 通过真实 Pi SDK 和适配器对本地 MCP 服务发现与调用，不请求模型，硬超时为 60 秒。该检查需要依赖已经安装，不需要设置 `PI_ENABLED=true`。

## 内置连接器检查

`connectorPresets.test.ts` 覆盖官方预设的配置校验、认证切换后旧凭证排除、空凭证与请求头换行错误、平台与 Pi 授权响应解析，以及 Token/Client Secret 的加密保存和管理接口脱敏。authorizationFlow.test.ts 覆盖浏览器自动跳转、已授权后发现、错误显式返回且不重试。上游 OAuth 与 OpenAPI 回归核对实际回调地址、账号归属、默认与独立绑定、303 返回、拒绝重复回调及授权期间业务派发为零。

2026-10-27 在 macOS 本机 Chrome 验证了预设选择、GitHub Token/OAuth 切换、Pi 桥接选择、键盘选择与 Escape 关闭、手动添加入口，以及 390px 窄屏无页面横向溢出。通过界面保存 Cloudflare Docs 的 Pi 连接，实际连接官方远程服务并发现两个工具。此记录只覆盖公开文档服务的真实发现；未使用供应商账号完成 Cloudflare、GitHub、Notion 或 Linear 的登录、刷新、撤销，不代表这些授权流程已实机验收。

本轮授权自动化与紧凑目录变更的分组回归合计 135 项通过（新增身份检查修正测试会话上下文后，该组单独重跑通过）。类型检查、ESLint、生产构建及真实无模型 Pi 检查通过。独立源文件副本完成冻结锁文件离线安装；macOS Chrome 检查分组目录、连接状态、多账号添加入口、Escape 关闭、手工回调默认折叠和 390px 窄屏，公开 Cloudflare Docs 的 Pi 目录刷新成功。此验收不包含真实供应商账号 OAuth。

## Go 与跨平台构建

GitHub Actions 在 Node.js 22、24 和独立 PostgreSQL 上执行冻结安装、重复迁移、类型检查、ESLint、生产构建、分组后端测试、无模型 Pi 桥接与 Go test/vet；Node.js 24 任务同时交叉构建六个架构。这些 Linux CI 检查不能替代各客户端、供应商 OAuth 和物理设备验收。

```sh
cd connector
node ../scripts/check.mjs 60 go test -timeout 60s ./...
node ../scripts/check.mjs 60 go vet ./...
cd ..
node scripts/check.mjs 600 pnpm connector:build
```

交叉构建覆盖 macOS、Linux、Windows 的 amd64/arm64。设备集成测试在同机启动实际 Go 进程；两台物理设备、系统登录自启动与 Windows 进程树需要在对应环境单独验证。

## Compose

先构建镜像，再运行隔离的检查项目：

```sh
node scripts/check.mjs 900 docker compose build
node scripts/check.mjs 600 node scripts/verify-compose.mjs
```

需要 Docker、支持 `!override` 的 Compose，并空出 54330/54332。脚本使用独立项目、临时凭证和新建卷，检查迁移、重复迁移、非 root 用户禁网执行 pnpm、页面、认证/API、Apps 隔离源与无模型 Pi 桥接，结束后清理该项目及卷。公网 DNS、证书和实际 iframe/CSP 行为需在部署环境验证。备份与恢复流程见 [部署说明](deployment.md)。

## Apps 浏览器检查

使用独立测试数据库，在 `.env` 中启用注册，启动开发服务并保持运行。构建页面夹具，再在另一个终端启动本地 MCP 服务：

```sh
pnpm --filter web exec vite build --config test-fixtures/vite.config.ts
node scripts/check.mjs 1800 pnpm exec tsx tests/browserApps.mts
```

该服务使用 `http://127.0.0.1:54820/mcp`。安装了 Chrome 和 Playwright 的环境可在服务运行期间执行：

```sh
node scripts/check.mjs 180 node scripts/verify-apps-browser.mjs
```

脚本默认导入 `playwright`，也可通过 `PLAYWRIGHT_MODULE` 指向现有模块。Playwright 不是项目依赖，需由浏览器检查环境提供。脚本检查初始化、结果传递、app-only 调用、全屏尺寸、iframe 连续性及关闭行为，输出写入 `.data/browser-acceptance/`。

浏览器夹具使用官方 App SDK 构建，不是官方发布示例。验证官方示例、实际外部客户端、公网 Sandbox 或真实模型任务时，需分别记录实际环境和结果。OAuth 本地协议测试也不能代替供应商账号的登录、刷新、撤销及回调配置验证。
