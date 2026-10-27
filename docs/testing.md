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

`pnpm test` 分六组顺序执行，覆盖连接、身份、工作空间、授权、交接、OAuth、Pi、协议目录、OpenAPI、交互与 Apps。每个后端测试进程由脚本强制限制为 60 秒，无自动重试。可使用同一入口运行专项：

```sh
pnpm test tests/upstreamOAuth.test.ts tests/openapiOAuth.test.ts
```

`pnpm test:pi` 通过真实 Pi SDK 和适配器对本地 MCP 服务发现与调用，不请求模型，硬超时为 60 秒。该检查需要依赖已经安装，不需要设置 `PI_ENABLED=true`。

## Go 与跨平台构建

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
