# 部署、备份与恢复

## 直接使用单端口镜像

`docker-compose.yml` 是独立部署文件，包含应用和 PostgreSQL，没有 `build`。数据库与应用文件分别使用持久卷，PostgreSQL 不发布主机端口。只需下载这一个文件，不需要 `.env`、源码或另行准备数据库：

```sh
docker compose -f docker-compose.yml up -d
```

然后打开 <http://localhost:4300>，页面直接显示“创建管理员账号”，第一个注册的账号自动成为管理员。之后的注册按 `ALLOW_REGISTRATION`（默认 `false`）处理；调整角色用“用户管理”或 `docker compose -f docker-compose.yml exec server pnpm user:role <邮箱> admin`。

这条命令依次运行：

1. `init`（一次性）：把数据库密码写入 `secrets` 卷的 `POSTGRES_PASSWORD` 文件（权限 0600）。显式设置的 `POSTGRES_PASSWORD` 优先，否则沿用已有文件，都没有才随机生成。
2. `db`：PostgreSQL 通过 `POSTGRES_PASSWORD_FILE` 读取该密码。
3. `migrate`（一次性）：执行数据库迁移，可重复执行。
4. `server`：迁移成功后启动。没有设置的 `BETTER_AUTH_SECRET`、`ENCRYPTION_KEY`、`DEVICE_AUTH_ENCRYPTION_KEY`、`PI_MCP_ADAPTER_OAUTH_FILE_KEY` 在第一次启动时生成，保存在 `files` 卷的 `/app/.data/secrets/`（目录 0700，文件 0600），之后每次启动都读取同一份。详见下面的[密钥](#密钥)。

从其他机器访问前，复制 `.env.docker.example` 为 `.env`，把 `PUBLIC_URL`（以及不同时的 `WEB_ORIGIN`）设为实际访问地址，例如 `http://服务器IP:4300` 或 Nginx 提供的 HTTPS 域名，再执行一次 `up -d`。未设置时默认 `http://localhost:4300`，启动日志会提示。镜像来自本仓库的 `ghcr.io/yibaiba/mcp-platform`，`PLATFORM_VERSION` 默认 `latest`；生产环境建议固定为 `sha-<完整提交号>` 或 Release 标签。

```sh
docker compose -f docker-compose.yml logs --tail=100 server
```

网页、API、MCP、WebSocket 和 Apps 共用 4300。有 Nginx 时将全部路径代理至该端口，保留 Host 和 WebSocket Upgrade 并关闭流式响应缓冲，HTTPS 由自己的 Nginx 管理。Apps 使用不透明源沙箱，无需额外子域名或端口。私有镜像需先登录镜像仓库。

本仓库同时保留 `compose.yaml`，Docker Compose 默认优先选取该文件，因此单端口镜像部署必须显式使用 `-f docker-compose.yml`，或设置 `COMPOSE_FILE=docker-compose.yml`。

## 密钥

平台有 4 把应用密钥，外加随附数据库的密码：

| 变量                            | 用途                                                     | 自动生成格式    |
| ------------------------------- | -------------------------------------------------------- | --------------- |
| `BETTER_AUTH_SECRET`            | 登录会话签名，账号表里第三方 OAuth Token 的加密          | 32 字节十六进制 |
| `ENCRYPTION_KEY`                | MCP 连接凭证、上游 OAuth Token、网络配置等加密保存的数据 | 32 字节 Base64  |
| `DEVICE_AUTH_ENCRYPTION_KEY`    | 设备认证 HMAC 主密钥（独立于 `ENCRYPTION_KEY`）          | 32 字节 Base64  |
| `PI_MCP_ADAPTER_OAUTH_FILE_KEY` | Pi 桥接 OAuth 文件加密                                   | 32 字节 Base64  |
| `POSTGRES_PASSWORD`             | 仅 `docker-compose.yml`：随附 PostgreSQL 的密码          | 32 字节十六进制 |

每把应用密钥按以下顺序取值：

1. 环境变量（`.env`、Compose 或 secret manager）里有非空值时一律使用它，平台不会把它写到任何地方，也不会覆盖已有文件。
2. 否则读取 `DATA_DIR/secrets/<变量名>`（Docker 里是 `/app/.data/secrets/`，在 `files` 卷里）。
3. 两者都没有时随机生成，以 0600 权限独占创建该文件，并在日志里给出路径、提醒备份（日志不含密钥）。

为保证升级不换钥，数据库表 `deployment_secrets` 记录每把密钥第一次使用时的指纹（加盐 SHA-256，不含密钥本身），每次启动都核对：

- 已有部署升级：第一次启动只记录 `.env` 里现有密钥的指纹，不生成、不改动任何值。缺少某把核心密钥（前三把）而数据库里已有账号时拒绝启动，不会生成新值让会话失效或加密数据解不开；Pi 文件密钥只加密依赖它才能存在的文件，未使用过时可以补生成。
- 数据库已经用过某把密钥，但环境变量和文件里都找不到（例如换了空数据卷）：拒绝启动并提示放回原值。
- 取到的值和指纹不一致（`.env` 被改、数据卷被换，或多个实例各自生成了密钥）：拒绝启动并说明原因。
- 写不了文件（数据目录只读、属主不对）：启动失败并提示“让 DATA_DIR 可写，或显式设置该变量”。
- 多实例：所有实例必须使用同一组密钥。共享同一个 `DATA_DIR` 卷时，同时启动也会读到同一份（独占创建，后到者读取先到者写入的值）；不共享时请显式设置全部密钥，否则第二个实例会被指纹检查拦下。
- 不希望自动生成（例如所有密钥都由 secret manager 注入）：设置 `AUTO_GENERATE_SECRETS=false`，缺少时直接报错。

确实要放弃旧密钥（例如密钥已经遗失，接受对应加密数据无法恢复）时，先备份，再在数据库执行 `delete from deployment_secrets where name = '<变量名>';` 并提供新值。轮换不会重新加密已有数据。

## 请求限流

服务端默认开启限流（`RATE_LIMIT_ENABLED=true`），计数保存在单个服务进程的内存里，重启后清零。超过限制时返回 HTTP 429 和 `Retry-After`（秒），等待这段时间后即可继续，被拒绝的请求不计入次数。

| 范围                                                                                        | 变量                            | 默认（次/分钟） | 计数对象                                                    |
| ------------------------------------------------------------------------------------------- | ------------------------------- | --------------- | ----------------------------------------------------------- |
| MCP 入口（`/mcp/*`，含 Streamable HTTP、REST 调用和产物下载）                               | `RATE_LIMIT_MCP_PER_CREDENTIAL` | 600             | 每个接入密钥或 OAuth 授权（按 Agent 区分）                  |
|                                                                                             | `RATE_LIMIT_MCP_PER_USER`       | 1200            | 同一用户的所有密钥和授权合计                                |
|                                                                                             | `RATE_LIMIT_MCP_PER_IP`         | 2400            | 每个客户端地址，在校验密钥之前计数，无效密钥也计入          |
| 登录与授权（OAuth 注册/授权/换取/撤销、CLI 登录、设备配对、`/api/v1/auth/*`，读取会话除外） | `RATE_LIMIT_AUTH_PER_IP`        | 120             | 每个客户端地址                                              |
| 账号登录与注册                                                                              | `RATE_LIMIT_LOGIN_PER_IP`       | 20              | 每个客户端地址、每个登录方式（由 Better Auth 内置限流执行） |

- 窗口为 60 秒滑动窗口；某一项设为 `0` 即关闭该项，`RATE_LIMIT_ENABLED=false` 关闭全部（包括 Better Auth 内置限流）。Compose 中留空表示使用默认值。
- 默认值按“一个客户端先列工具再并发调用几百次”的用法留有余量：初始化、多次 `tools/list` 加 300 个并发 `tools/call` 不会触发。持续每秒超过 10 次调用的单个密钥会被限制；批量任务较多时调大 `RATE_LIMIT_MCP_PER_CREDENTIAL`。参考：MCPHub 默认每分钟 480 次，MetaMCP 分端点和用户两层。
- MCP 入口的 429 响应体是 JSON-RPC 错误（`id` 为 `null`，`code` 为 `-32000`，`data` 内含 `scope`、`retryAfter` 和 `limit`）；其他接口返回 `{ code: "RATE_LIMITED", error, message, scope, retryAfter }`。

### 客户端地址与反向代理

按地址计数时使用 TCP 对端地址；只有对端属于 `TRUSTED_PROXIES` 时才读取 `X-Forwarded-For`，并从右往左跳过受信任的代理，取第一个不受信任的地址。客户端自己写的 `X-Forwarded-For` 不能越过第一个不受信任的地址。

- 默认 `TRUSTED_PROXIES=loopback,private`：适合同一台主机或同一 Docker 网络里的 Nginx/Caddy。代理需要追加 `X-Forwarded-For`（Nginx：`proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`）；没有这个头时，所有人都会被算作代理这一个地址。
- 客户端直接从内网访问 4300（没有代理）时，内网客户端可以伪造 `X-Forwarded-For` 换地址计数，应设为 `TRUSTED_PROXIES=none`。
- 代理在其他网段时，列出它的地址或网段，例如 `TRUSTED_PROXIES=203.0.113.10,198.51.100.0/24`。

### 多实例

计数不在实例之间共享：同一用户的请求分到 N 个实例时，实际上限最多是 N 倍；重启也会清零。多实例部署请在入口负载均衡上做全局限流，或用会话粘滞把同一客户端固定到一个实例。

## 源码构建部署

`compose.yaml` 从本仓库根目录构建 Dockerfile 的 `app` 阶段，运行与发布镜像相同的应用。构建配置不包含 PostgreSQL 服务，通过 `DATABASE_URL` 连接已有数据库。

默认单实例，没有 Redis、消息队列或多副本路由。MCP 会话和在线设备请求由服务进程维护；重启会中断请求并记录结果未知，不自动重放。

1. 安装 Docker/Compose，准备容器可访问的 PostgreSQL 17 数据库（需要 pgvector）。
2. 只需设置 `DATABASE_URL`，例如写入 `.env`：`DATABASE_URL=postgresql://用户:密码@主机:5432/库名`。数据库地址中的 `localhost` 指应用容器自身，用户名与密码中的特殊字符需 URL 编码。不要在仓库提交 `.env`。
3. 启动后打开页面创建第一个账号（自动成为管理员）。从其他机器访问前设置 `PUBLIC_URL`（`WEB_ORIGIN` 默认与它相同）；密钥规则同[上文](#密钥)，生成的密钥在 `files` 卷的 `/app/.data/secrets/`。

```sh
docker compose -f compose.yaml up -d --build
docker compose -f compose.yaml logs --tail=100 server
```

`migrate` 服务在 server 启动前执行迁移。不用 Docker 时：`pnpm db:migrate`，然后 `NODE_ENV=production pnpm start`，同样只需要 `DATABASE_URL`。

`/health` 会检查数据库。应用只监听 4300，产物与 Pi 会话保存在文件卷。设备连接器在实际设备运行，不在服务器容器中启动桌面软件。镜像内包含由本仓库 Go 源码构建的六种系统与架构的安装文件。

Apps 的可信代理通过 `data:` iframe 获得独立的不透明源，实际 App 运行在受 sandbox 属性和响应 CSP 限制的内层 iframe。平台固定消息窗口及来源，专用 frame 创建请求不携带凭证；管理 API 不接受 null-origin CORS。`APPS_ORIGIN`、`APPS_PORT`、`DOMAIN` 和 `APPS_DOMAIN` 不再使用。开发环境可以继续使用 Vite 的 4301，Apps 资源仍由后端提供。

镜像把 Corepack 缓存放在 `/usr/local/share/corepack`，运行用户 node 可以禁网执行构建时安装的 pnpm。生产启动会检查 `apps/web/dist/index.html`，缺少构建产物会直接失败。浏览器页面路由返回应用入口，缺失的 API、Apps 文档和静态资源仍返回 404。

## 本仓库镜像发布与验收

`.github/workflows/ci.yml` 对 PR、main push、手动运行和 `release.published` 执行 Node.js 22/24 检查，再分别使用原生 amd64、arm64 运行器构建应用镜像，各自核对镜像源码并执行隔离 Compose 和 Python 冷/热缓存验收。只有 `release.published` 会推送镜像；两个架构均通过后，发布统一的 `ghcr.io/yibaiba/mcp-platform:latest`、Release 标签和 `sha-<完整提交号>` 标签。其他触发方式只验证，不发布。Release 同时上传六种连接器二进制、SHA256SUMS 和安装脚本。镜像名由当前 GitHub 仓库生成，源码标签固定指向本项目。发布使用该仓库的 GitHub Token，首次使用需要确认 GHCR 包的读取权限。

本机执行：

```sh
node scripts/check.mjs 900 docker build --target app -t mcp-platform:local .
node scripts/check.mjs 600 node scripts/verify-compose.mjs
```

验收直接使用 `docker-compose.yml`。先以零配置（没有 `.env`、没有任何密钥、不设 `ALLOW_REGISTRATION`）在回环地址 4300 一条 `up -d` 启动，检查第一个账号注册为管理员、第二个账号被拒、生成的密钥文件为 0600 且属于 node、`down` 后再 `up -d` 会话仍然有效；再以独立项目、全部显式随机凭证和新卷启动，仅在回环地址发布临时应用端口 54330，并确认显式密钥没有写入数据卷。检查镜像源码、禁网 pnpm、新库与重复迁移、网页与资源、认证/API、六种连接器下载，并实际运行本机对应的 Go 连接器检查同端口 WebSocket 上线和撤销。另检查 Apps 一次性文档和 CSP、真实无模型 Pi 桥接，结束后清理本次资源。可通过 `PLATFORM_TEST_IMAGE` 指定另一个由当前源码构建的本地标签。该检查需要支持 `!override` 的 Compose；真实浏览器和公网 Nginx/HTTPS 需分别验证，见[测试说明](testing.md)。

## 升级与回退

应用迁移前先停止服务并备份数据库、整个 DATA_DIR、应用、设备认证与 Pi 加密密钥。0003/0004 增加授权绑定、目录快照和加密交互状态；0005/0006 增加工作空间修订、任务事件、权限申请、临时授权、身份指纹与交接。旧 Profile 省略新增字段时保留已有值。本轮 `0007` 升级设备 HMAC，旧 Token 通道不再接受认证；必须同时升级 Go 连接器并逐台重新配对，保留设备 ID 与连接引用。`0008`/`0009` 增加声明模板、发现和 REST 持久化。Windows stdio host 与连接器必须使用相同版本。

### 从需要手填密钥的版本升级

- 保留现有 `.env`，不要删除其中的 `POSTGRES_PASSWORD`、`BETTER_AUTH_SECRET`、`ENCRYPTION_KEY`、`DEVICE_AUTH_ENCRYPTION_KEY`。显式值永远优先；`0025` 迁移新增 `deployment_secrets`，升级后第一次启动只记录这些值的指纹。
- `docker-compose.yml` 改为 `docker compose -f docker-compose.yml up -d` 一条命令：新增一次性的 `init`、`migrate` 服务和 `secrets` 卷，数据库改用 `POSTGRES_PASSWORD_FILE`（`init` 会把 `.env` 里的 `POSTGRES_PASSWORD` 写进去）。PostgreSQL 只在数据卷第一次创建时使用密码，已有数据卷不受影响。
- 之前没设置 `PI_MCP_ADAPTER_OAUTH_FILE_KEY` 的部署会自动生成一把并保存在文件卷里；之前设置过的继续用原值。
- `ALLOW_REGISTRATION=false` 时，空数据库的第一个注册不再被拒绝（用于创建管理员）；已有账号的部署不受影响。
- 自定义 Compose 或编排文件：如果在 server 启动前没有执行迁移，启动会提示先运行 `pnpm db:migrate`。

运行中的工具、交互和 App 不支持跨重启恢复；升级后明确中断，禁止通过重新派发恢复。任务快照与输出检查点可查看，任务临时授权随中断任务失效；外部凭证临时授权保留至原截止时间。回退旧程序时恢复升级前数据库、持久目录及原加密密钥，不假设旧程序能读取新授权数据。升级前应在隔离环境中验证新库迁移、旧库备份恢复后升级及重复迁移，并检查原有 Profile 授权保持一致。

Pi 已包含在默认镜像中；Pi MCP 桥接无需启用推理或配置模型。仅执行内置 Agent 任务时在 `.env` 设置 `PI_ENABLED=true` 并配置模型，执行 `docker compose up -d server` 更新容器配置，无需重新安装 Pi 或重建镜像。模型供应商密钥需通过自己的 Compose override 的 `environment` 或 secret manager 注入；默认 Compose 不把全部宿主机环境传入容器。Pi OAuth 还需 `PI_MCP_ADAPTER_OAUTH_FILE_KEY`，见 [Pi](pi.md)。

## 备份

```sh
pnpm backup /absolute/new-backup-directory
```

脚本用于源码构建部署，需要主机安装与数据库匹配的 PostgreSQL 客户端 `pg_dump`，且主机能访问 `.env` 或当前环境变量指定的 `DATABASE_URL`；连接密码通过子进程环境传递。脚本先检查客户端可用性，再暂停 server，生成外部 PostgreSQL 自定义格式备份、文件卷 tar、受限权限的 `.env` 副本，最后恢复服务。中途失败会以非零状态退出，不报告成功。备份期间设备掉线；执行中的工具结果可能未知，维护前应先等运行任务结束。数据量较大时可手工执行同样步骤并按容量调整命令超时（脚本每条命令 180 秒）。

单端口镜像部署使用随附的数据库容器备份，不需要主机安装 `pg_dump`。先创建权限为 700 的新备份目录并暂停应用；以下命令中的 `/backup` 指该目录：

```sh
umask 077
docker compose -f docker-compose.yml stop server
docker compose -f docker-compose.yml exec -T db pg_dump -U platform -d platform -Fc > /backup/database.dump
docker compose -f docker-compose.yml run --rm --no-deps -T server tar -C /app/.data -cf - . > /backup/files.tar
[ -f .env ] && cp .env /backup/platform.env
docker compose -f docker-compose.yml start server
```

逐条检查退出码；任何步骤失败都不能报告备份成功，并在维护结束时恢复应用。

`platform.env`（显式设置的密钥）和 `files.tar`（其中 `secrets/` 是自动生成的密钥）都必须私密保存；没有原 `ENCRYPTION_KEY` 不能解密 MCP/OAuth 凭证。设备密钥依赖原 `DEVICE_AUTH_ENCRYPTION_KEY`；独立保护并另行备份该主密钥，遗失后无法认证现有设备，须逐台重配。Pi 凭证还依赖原 Pi 文件密钥。备份文件不要上传到公开仓库。

## 恢复到新的空部署

先保留旧部署，使用新的 Compose 项目名或新主机；下面命令只针对空库与空文件卷。有 `platform.env` 时复制为新目录 `.env`，调整域名后使用相同密钥，完成镜像构建或拉取。自动生成的密钥随 `files.tar` 恢复；必须在 server 第一次启动之前恢复文件卷，否则新部署会先生成另一组密钥（之后恢复文件卷会覆盖它们，数据库指纹也随备份恢复，仍可正常启动）。

源码构建部署需要预先创建外部空数据库并设置其 `DATABASE_URL`。在主机配置与目标库匹配的 `PGHOST`、`PGPORT`、`PGUSER` 和 `.pgpass`，将下面 `platform` 替换为目标数据库名；[pg_restore](https://www.postgresql.org/docs/17/app-pgrestore.html) 使用 `--dbname` 指定恢复目标。

```sh
pg_restore --dbname=platform --exit-on-error /backup/database.dump
docker compose -f compose.yaml run --rm --no-deps -T server tar -C /app/.data -xf - < /backup/files.tar
docker compose -f compose.yaml run --rm --no-deps server pnpm db:migrate
docker compose -f compose.yaml up -d
```

单端口镜像部署通过随附的数据库容器恢复：

```sh
docker compose -f docker-compose.yml up -d db
until docker compose -f docker-compose.yml exec -T db pg_isready -U platform -d platform; do sleep 2; done
docker compose -f docker-compose.yml exec -T db pg_restore -U platform -d platform --exit-on-error < /backup/database.dump
docker compose -f docker-compose.yml run --rm --no-deps -T server tar -C /app/.data -xf - < /backup/files.tar
docker compose -f docker-compose.yml run --rm --no-deps server pnpm db:migrate
docker compose -f docker-compose.yml up -d
```

恢复后验证登录、连接授权、产物哈希、设备重新上线和配置权限。域名变化需更新设备 `server` 和上游 OAuth 回调注册，重新签发包含旧 resource URL 的 Agent OAuth 授权。恢复演练和公网站点证书仍须在部署环境验收，不能把配置检查当作已部署。

设备 HMAC 升级后，旧设备显示待重新配对，必须同时更新连接器并完成重配。详见 [设备认证升级](device-auth-verification.md)。
