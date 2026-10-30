# 部署、备份与恢复

## 直接使用单端口镜像

`docker-compose.yml` 是独立部署文件，包含应用和 PostgreSQL，没有 `build`。数据库与应用文件分别使用持久卷，PostgreSQL 不发布主机端口。下载该文件和 `.env.docker.example` 即可配置，无需下载应用源码或另行准备数据库。

1. 将 `.env.docker.example` 复制为 `.env`，填写随机十六进制 `POSTGRES_PASSWORD`、`BETTER_AUTH_SECRET` 和 32 字节 Base64 `ENCRYPTION_KEY` 和独立的 `DEVICE_AUTH_ENCRYPTION_KEY`。镜像来自本仓库的 `ghcr.io/yibaiba/mcp-platform`，`PLATFORM_VERSION` 可使用已发布的 `latest` 或 `sha-<完整提交号>`。Compose 自动注入容器内部的 `DATABASE_URL`，无需手填。
2. 将 `PUBLIC_URL` 和 `WEB_ORIGIN` 均设为实际访问地址，例如 `http://服务器IP:4300`，或 Nginx 提供的同一个 HTTPS 域名。
3. 首次注册时临时启用 `ALLOW_REGISTRATION=true`，注册后关闭并重新创建应用容器。第一个注册的账号自动成为管理员；之后调整角色用“用户管理”或 `docker compose exec server pnpm user:role <邮箱> admin`。

```sh
docker compose -f docker-compose.yml pull
docker compose -f docker-compose.yml up -d --wait db
docker compose -f docker-compose.yml run --rm --no-deps server pnpm db:migrate
docker compose -f docker-compose.yml up -d
docker compose -f docker-compose.yml logs --tail=100 server
```

网页、API、MCP、WebSocket 和 Apps 共用 4300。有 Nginx 时将全部路径代理至该端口，保留 Host 和 WebSocket Upgrade 并关闭流式响应缓冲，HTTPS 由自己的 Nginx 管理。Apps 使用不透明源沙箱，无需额外子域名或端口。私有镜像需先登录镜像仓库。

本仓库同时保留 `compose.yaml`，Docker Compose 默认优先选取该文件，因此单端口镜像部署必须显式使用 `-f docker-compose.yml`，或设置 `COMPOSE_FILE=docker-compose.yml`。

## 源码构建部署

`compose.yaml` 从本仓库根目录构建 Dockerfile 的 `app` 阶段，运行与发布镜像相同的应用。构建配置不包含 PostgreSQL 服务，通过 `DATABASE_URL` 连接已有数据库。

默认单实例，没有 Redis、消息队列或多副本路由。MCP 会话和在线设备请求由服务进程维护；重启会中断请求并记录结果未知，不自动重放。

1. 安装 Docker/Compose，准备容器可访问的 PostgreSQL 17 数据库。
2. `cp .env.example .env`；设置外部 `DATABASE_URL`、随机 `BETTER_AUTH_SECRET` 和 32 字节 Base64 `ENCRYPTION_KEY` 和独立的 `DEVICE_AUTH_ENCRYPTION_KEY`。`PUBLIC_URL` 和 `WEB_ORIGIN` 都填写实际访问地址；直连使用 `http://服务器IP:4300`，Nginx 使用同一个 HTTPS 域名。数据库地址中的 `localhost` 指应用容器自身，用户名与密码中的特殊字符需 URL 编码。不要在仓库提交 `.env`。
3. 首次临时启用 `ALLOW_REGISTRATION=true`，注册后关闭并重建 server 容器。第一个注册的账号自动成为管理员（已有用户的库不变）；之后用“用户管理”或 `pnpm user:role` 调整角色。

```sh
docker compose -f compose.yaml build
docker compose -f compose.yaml run --rm --no-deps server pnpm db:migrate
docker compose -f compose.yaml up -d
docker compose -f compose.yaml logs --tail=100 server
```

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

验收直接使用 `docker-compose.yml`，以独立项目、随机凭证和新卷启动应用与数据库，仅在回环地址发布临时应用端口 54330。检查镜像源码、禁网 pnpm、新库与重复迁移、网页与资源、认证/API、六种连接器下载，并实际运行本机对应的 Go 连接器检查同端口 WebSocket 上线和撤销。另检查 Apps 一次性文档和 CSP、真实无模型 Pi 桥接，结束后清理本次资源。可通过 `PLATFORM_TEST_IMAGE` 指定另一个由当前源码构建的本地标签。该检查需要支持 `!override` 的 Compose；真实浏览器和公网 Nginx/HTTPS 需分别验证，见[测试说明](testing.md)。

## 升级与回退

应用迁移前先停止服务并备份数据库、整个 DATA_DIR、应用、设备认证与 Pi 加密密钥。0003/0004 增加授权绑定、目录快照和加密交互状态；0005/0006 增加工作空间修订、任务事件、权限申请、临时授权、身份指纹与交接。旧 Profile 省略新增字段时保留已有值。本轮 `0007` 升级设备 HMAC，旧 Token 通道不再接受认证；必须同时升级 Go 连接器并逐台重新配对，保留设备 ID 与连接引用。`0008`/`0009` 增加声明模板、发现和 REST 持久化。Windows stdio host 与连接器必须使用相同版本。

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
cp .env /backup/platform.env
docker compose -f docker-compose.yml start server
```

逐条检查退出码；任何步骤失败都不能报告备份成功，并在维护结束时恢复应用。

`platform.env` 含数据库与加密密钥，必须私密保存；没有原 `ENCRYPTION_KEY` 不能解密 MCP/OAuth 凭证。设备密钥依赖原 `DEVICE_AUTH_ENCRYPTION_KEY`；独立保护并另行备份该主密钥，遗失后无法认证现有设备，须逐台重配。Pi 凭证还依赖原 Pi 文件密钥。备份文件不要上传到公开仓库。

## 恢复到新的空部署

先保留旧部署，使用新的 Compose 项目名或新主机；下面命令只针对空库与空文件卷。复制备份 `platform.env` 为新目录 `.env`，调整域名后使用相同密钥，完成镜像构建或拉取。

源码构建部署需要预先创建外部空数据库并设置其 `DATABASE_URL`。在主机配置与目标库匹配的 `PGHOST`、`PGPORT`、`PGUSER` 和 `.pgpass`，将下面 `platform` 替换为目标数据库名；[pg_restore](https://www.postgresql.org/docs/17/app-pgrestore.html) 使用 `--dbname` 指定恢复目标。

```sh
pg_restore --dbname=platform --exit-on-error /backup/database.dump
docker compose -f compose.yaml run --rm --no-deps -T server tar -C /app/.data -xf - < /backup/files.tar
docker compose -f compose.yaml run --rm --no-deps server pnpm db:migrate
docker compose -f compose.yaml up -d
```

单端口镜像部署通过随附的数据库容器恢复：

```sh
docker compose -f docker-compose.yml up -d --wait db
docker compose -f docker-compose.yml exec -T db pg_restore -U platform -d platform --exit-on-error < /backup/database.dump
docker compose -f docker-compose.yml run --rm --no-deps -T server tar -C /app/.data -xf - < /backup/files.tar
docker compose -f docker-compose.yml run --rm --no-deps server pnpm db:migrate
docker compose -f docker-compose.yml up -d
```

恢复后验证登录、连接授权、产物哈希、设备重新上线和配置权限。域名变化需更新设备 `server` 和上游 OAuth 回调注册，重新签发包含旧 resource URL 的 Agent OAuth 授权。恢复演练和公网站点证书仍须在部署环境验收，不能把配置检查当作已部署。

设备 HMAC 升级后，旧设备显示待重新配对，必须同时更新连接器并完成重配。详见 [设备认证升级](device-auth-verification.md)。
