# 部署、备份与恢复

## 直接使用单端口镜像

`docker-compose.yml` 是独立部署文件，包含应用和 PostgreSQL，没有 `build`。数据库与应用文件分别使用持久卷，PostgreSQL 不发布主机端口。下载该文件和 `.env.docker.example` 即可配置，无需下载应用源码或另行准备数据库。

1. 将 `.env.docker.example` 复制为 `.env`，填写已发布的 `PLATFORM_VERSION`、随机十六进制 `POSTGRES_PASSWORD` 和三项随机密钥。Compose 自动注入容器内部的 `DATABASE_URL`，无需手填。镜像必须包含 mcp-manger PR #3 的统一入口改动；合并提交不会自动产生镜像标签，必须先发布对应镜像。
2. 将 `PUBLIC_URL` 和 `WEB_ORIGIN` 均设为实际访问地址，例如 `http://服务器IP:4300`，或 Nginx 提供的同一个 HTTPS 域名。
3. 首次注册时临时启用 `ALLOW_REGISTRATION=true`，注册后关闭并重新创建应用容器。

```sh
docker compose -f docker-compose.yml pull
docker compose -f docker-compose.yml up -d --wait db
docker compose -f docker-compose.yml run --rm --no-deps server pnpm db:migrate
docker compose -f docker-compose.yml up -d
docker compose -f docker-compose.yml logs --tail=100 server
```

网页、API、MCP、WebSocket 和 Apps 共用 4300。有 Nginx 时将全部路径代理至该端口，保留 WebSocket Upgrade 并关闭流式响应缓冲。Apps 使用镜像内的不透明源沙箱，无需 Apps 子域名或 4302。私有镜像需先登录镜像仓库。

本仓库同时保留 `compose.yaml`，Docker Compose 默认优先选取该文件，因此单端口镜像部署必须显式使用 `-f docker-compose.yml`，或设置 `COMPOSE_FILE=docker-compose.yml`。

## 当前源码构建部署

当前工作区源码仍使用 Caddy 网页服务和独立 Apps 监听，`compose.yaml` 按该源码结构构建；它与上面的远端统一镜像分别对应不同代码版本。构建部署同样只连接外部 PostgreSQL，不创建数据库容器。

默认单实例，没有 Redis、消息队列或多副本路由。MCP 会话和在线设备请求由服务进程维护；重启会中断请求并记录结果未知，不自动重放。

1. 云主机安装 Docker/Compose，DNS 指向主机，开放 80/443（Caddy 自动申请证书）。
2. `cp .env.example .env`；设置外部 `DATABASE_URL`、`DOMAIN`、`PUBLIC_URL=https://你的域名`、`WEB_ORIGIN=https://你的域名`、随机 `BETTER_AUTH_SECRET`、32 字节 base64 `ENCRYPTION_KEY`。数据库必须能从容器内访问。将示例的本地 `APPS_ORIGIN` 改为 `https://apps.你的域名`，并设置 `APPS_DOMAIN=apps.你的域名`，为其配置 DNS；不要把开发默认 localhost 地址留在生产配置中。不要在仓库提交 `.env`。
3. 首次临时启用 `ALLOW_REGISTRATION=true`，注册后关闭并重建 server 容器。

```sh
docker compose -f compose.yaml build
docker compose -f compose.yaml run --rm --no-deps server pnpm db:migrate
docker compose -f compose.yaml up -d
docker compose -f compose.yaml logs --tail=100 server
```

`/health` 会检查外部数据库；Caddy 转发 `/api/*`、`/mcp/*`、`/.well-known/*` 和 WebSocket。数据库由用户独立维护，产物、Pi 会话和证书存放在持久卷。设备连接器在实际设备运行，不在服务器容器中启动桌面软件。

Apps 使用单独源站，Caddy 将 APPS_DOMAIN 代理至 server:4302，仅暴露 Sandbox Proxy 和一次性 iframe 文档，不暴露管理 API。APPS_ORIGIN 必须与 PUBLIC_URL/WEB_ORIGIN 不同源；自定义域名时同步修改三项配置与 DNS。开发 `pnpm dev` 自动启动 4302，不需要单独启动命令。实际公网域名、证书、iframe/CSP 仍需部署验收。

镜像把 Corepack 缓存放在 `/usr/local/share/corepack`，运行用户 node 可以直接使用构建时安装的 pnpm，无需启动时再次联网下载。修改镜像后，可在本机运行 `node scripts/check.mjs 600 node scripts/verify-compose.mjs`：需要先构建出默认的 mcp-platform-server/web 镜像，并空出 54330/54332。验收使用独立项目名、随机临时凭证、新建卷和仅回环地址的 HTTP 端口，检查非 root 用户禁网执行 pnpm、新库及重复迁移、Caddy 静态页、健康/登录 API、隔离源 HTTP 契约与真实无模型 Pi 桥接；结束时只清理本次项目和卷。该检查需要支持 `!override` 的 Compose，不验证公网证书签发。

## 升级与回退

应用迁移前先停止服务并备份数据库、整个 DATA_DIR、SQL 与 Pi 加密密钥。0003/0004 增加授权绑定、目录快照和加密交互状态；0005/0006 增加工作空间修订、任务事件、权限申请、临时授权、身份指纹与交接。旧 Profile 省略新增字段时保留已有值。旧连接器继续原功能，新会话/授权/交互能力要求升级连接器。Windows stdio host 与连接器必须使用相同版本。

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

`platform.env` 含数据库与加密密钥，必须私密保存；没有原 `ENCRYPTION_KEY` 不能解密 MCP/OAuth 凭证。Pi 凭证还依赖原 Pi 文件密钥。备份文件不要上传到公开仓库。

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
