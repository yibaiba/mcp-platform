# 搜索、指标、远程 CLI 与结果节选交付记录

按搜索、累计指标、远程管理 CLI、长结果节选四阶段推进。各阶段提交独立；实现、自动化、性能、实机、合并、CI 和发布状态分别记录。

## 搜索

- 新 Profile 使用精确检索及最低分数 0.3；迁移后的旧 Profile 和省略 searchOptions 的旧模板不启用过滤。
- 精确路径保留 float8[] 并在数据库内计算归一化向量点积、阈值过滤、排序和 LIMIT。应用只读取向量元数据与最终命中。
- 加密目录按工具保存，热查询读取哈希元数据；旧快照首次访问时在本地拆分，不访问上游。定义缺失或改变才重新 Embedding，写入按批 upsert。
- HNSW 以作用域独立物理表和索引隔离，状态记录为 building/ready/failed/cleaning。需要显式重建；未就绪不会退回精确模式。vector 最大 2000 维，m=16、efConstruction=64、efSearch=100，严格迭代扫描。
- 管理接口：GET /api/v1/profiles/:id/search-index，POST 同路径 /rebuild；POST /api/v1/profiles/:id/search-test。这些操作仅处理目录与 Embedding，不调用业务工具。
- REST 凭据作用域的状态和重建入口：/mcp/:profileId/rest/search-index 和 /rebuild。不同调用身份和客户端能力有独立索引；管理页面的重建只处理当前管理身份。
- 自托管部署固定为 pgvector/pgvector:0.8.1-pg17；外部数据库须安装 pgvector >=0.8.0。迁移 0010/0011 保留原数组，扩展不可用时明确终止并给出修复步骤。

### 本地验证（2026-10-29）

- macOS、Node.js 24.17.0、pnpm 10.12.4；隔离容器 PostgreSQL 17.11 / pgvector 0.8.6，4 CPU / 8 GiB 配置（Docker 实际可用内存 7.75 GiB），x86_64 镜像。
- 冻结锁文件安装、服务端与前端类型检查通过。
- discovery + vectorSearch 专项 6 项通过，保持后端进程 60 秒硬超时。
- 初次测试因隔离容器端口与开发库冲突导致认证失败，未执行迁移。改为随机回环端口后迁移成功。第二次测试暴露 Drizzle 数组插值误生成 SQL record，改为参数化数组后通过；未放宽超时。
- 固定镜像首次及第二次在线拉取因 Docker Hub TLS 握手超时失败；本地验证使用已有 pgvector 镜像，不能据此宣称固定部署镜像验证通过。
- 独立基准：`node scripts/check.mjs 600 pnpm exec tsx scripts/benchmark-search.mts`，须指定隔离迁移库 DATABASE_URL。固定 10000 工具 / 1536 维 / 30 次热查询，合成聚类数据。性能结果待记录；不能代表真实 Embedding 供应商召回质量。

## 尚待完成的阶段与验收

累计指标、CLI、结果节选、整体回归和 amd64/arm64 镜像验证正在实施。真实 SSO、浏览器交互、Embedding 供应商、模型任务和物理设备尚未验收。

未合并、未运行远程 CI、未发布。升级前必须备份数据库、数据目录和加密密钥；回退恢复配套备份，不能假定旧程序兼容新授权数据。

## 累计指标

保留历史 gauge，增加进程级 `platform_calls_total`、`platform_active_calls`、`platform_call_total_duration_seconds`、`platform_call_execution_duration_seconds`、`platform_searches_total` 和 `platform_search_duration_seconds`。后三个 duration 指标为 histogram，固定秒桶为 0.01、0.025、0.05、0.1、0.25、0.5、1、2.5、5、10、30、60、120、300、+Inf。

业务调用仅在统一生命周期终态累计一次；交互续答属于同一逻辑调用。总耗时包含等待，执行耗时只累计 adapter 调用轮次。取消标签为 cancelled，表示取消请求且上游结果可能未知，不能解读为上游未执行。指标不读取历史来累计，清理历史不会重置；进程重启重置。搜索另行计数，代理转发实际工具只有一次业务计数。标签只包含 entry、adapter、status、strategy，不包含工具名、账号、查询或错误文本。/metrics 仍使用独立凭据。

PromQL：

```promql
sum(rate(platform_calls_total[5m]))
sum(rate(platform_calls_total{status=~"tool_error|failed"}[5m])) / sum(rate(platform_calls_total[5m]))
histogram_quantile(0.95, sum by (le) (rate(platform_call_total_duration_seconds_bucket[5m])))
histogram_quantile(0.99, sum by (le) (rate(platform_call_execution_duration_seconds_bucket[5m])))
histogram_quantile(0.95, sum by (le, strategy) (rate(platform_search_duration_seconds_bucket[5m])))
```

2026-10-29 同一隔离环境的 runtimeMetrics、interactions、legacyInteractions 12 项通过，包括真实 HTTP REST 幂等调用及历史清理。使用每进程 60 秒硬超时。第一轮数据库性能基准：精确 P95 3749 ms，未达标；HNSW P95 29.9 ms、Recall@10 100%。正在优化精确数组计算，未降低验收规模或放宽阈值。

## 远程 CLI

独立 CLI 管理授权使用浏览器确认、PKCE S256、随机 state 及本机随机回环端口。邮箱和已配置 SSO 复用网页登录；SSO 登录保留当前授权地址。access token 为 1 小时，刷新令牌轮换；授权在最初签发后 30 天到期，不通过刷新无限延长。服务端只存摘要，每次管理请求复查账号状态、授权和当前角色。账号停用撤销已有 CLI 授权及未兑换授权码；账号页可逐项撤销。Cookie 写请求继续检查 Origin。管理令牌不能使用业务执行、交互或调用取消接口。

仓库运行 `pnpm cli --help`，构建 `pnpm --filter @platform/cli build` 后可直接运行 `node packages/cli/dist/main.js`（机器读取 stdout 时推荐直接运行构建入口）。支持 login/logout/whoami、env add/use/list、connections list/get/add/update/connect/stop、profiles list/get、keys list/create/revoke、tools list/describe/call、calls status/result/answer/cancel、config preview/apply/status/export。`--file` 或 `--data` 输入 JSON；所有命令接受 `--json`，诊断写 stderr。`--env` 临时选择环境；业务操作必须传 `--profile` 并注入 `MCP_PLATFORM_AGENT_TOKEN`，`MCP_PLATFORM_ACCESS_TOKEN` 可注入管理 access token。刷新在发送管理请求前完成，业务调用及变更不重试。密钥明文只在创建响应中输出。

凭据在操作系统用户配置目录保存（macOS Application Support、Linux XDG_CONFIG_HOME、Windows APPDATA），POSIX 目录 0700 / 文件 0600；Windows 使用当前用户 ACL。`MCP_PLATFORM_CONFIG_DIR` 可为自动化指定独立目录。退出成功前服务端必须完成撤销；失败时保留本地信息并返回非零。退出码：0 成功，2 参数错误，3 认证/权限错误，4 网络/服务错误，5 业务工具失败。

真实 HTTP 与本机回调协议测试覆盖一次性授权码、错误 PKCE、刷新轮换、撤销、停用账号、只读 scope、角色与 Origin、Agent/管理凭据隔离、随机回环回调错误 state、文件权限、多环境、JSON 输出、退出码、密钥签发和真实 MCP 夹具业务调用。浏览器与供应商 SSO 实机验收仍单独记录；此类协议测试不替代实机。

## 长结果节选

Profile 与声明式模板的 resultPresentation 默认关闭。开启后普通 text 总计超过 32768 字节时，按各块 UTF-8 字节长度比例分配 8192 字节的原文保留预算，保留头尾并显式标记省略；标记和读取说明额外显示。阈值和保留预算均可配置。结果内容顺序、structuredContent、媒体及资源保持不变；错误、交互及 Apps 结果不节选，也不改变输出 Schema 校验。

完整上游结果先以 JSON 产物保存，并与调用 Profile、产生主体、工具和调用 ID 绑定，再产生展示结果。元数据和文本均包含产物 ID、文件大小、SHA-256 与读取方式。沿用产物字节读取与认证下载；原调用身份及当前工具权限必须仍有效，不能通过把原文加入其他 Profile 授权来绕过。REST 幂等重取使用已保存的展示结果，不重复创建原文。保存失败返回 RESULT_ORIGINAL_SAVE_FAILED 及调用 ID，记录 result_error，不返回成功或重放上游。

2026-10-29 结果节选与既有产物专项共 10 项通过（隔离 PostgreSQL，60 秒硬超时）。覆盖中文/UTF-8、多块与媒体不变、原文一致、结构化保留、跨凭据拒绝、撤权、持久化失败和 REST 重取不重放。CLI HTTP/回环协议专项 3 项通过；类型检查及 Lint 通过。原文沿用临时产物授权的有效期、Profile 修订和上游绑定失效语义；磁盘文件不因界面关闭节选而删除。
