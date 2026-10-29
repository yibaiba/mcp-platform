# 搜索、指标、远程 CLI 与结果节选交付记录

按搜索、累计指标、远程管理 CLI、长结果节选四阶段推进。各阶段提交独立；实现、自动化、性能、实机、合并、CI 和发布状态分别记录。

## 搜索

- 新 Profile 使用精确检索及最低分数 0.3；迁移后的旧 Profile 和省略 searchOptions 的旧模板不启用过滤。
- 精确路径保留 float8[] 并在数据库内计算归一化向量点积、阈值过滤、排序和 LIMIT。应用只读取向量元数据与最终命中。
- 加密目录按工具保存，热查询读取哈希元数据；旧快照首次访问时在本地拆分，不访问上游。定义缺失或改变才重新 Embedding，写入按批 upsert。
- HNSW 以作用域独立物理表和索引隔离，状态记录为 building/ready/failed/cleaning。需要显式重建；未就绪不会退回精确模式。vector 最大 2000 维，m=16、efConstruction=64、efSearch=100，严格迭代扫描。
- 管理接口：GET /api/v1/profiles/:id/search-index，POST 同路径 /rebuild；POST /api/v1/profiles/:id/search-test。这些操作仅处理目录与 Embedding，不调用业务工具。
- REST 凭据作用域的状态和重建入口：/mcp/:profileId/rest/search-index 和 /rebuild。不同调用身份和客户端能力有独立索引；管理页面的重建处理当前管理身份；管理 API 的重建可显式传入 `{ "credentialId": "Agent 凭据 ID", "capabilities": {} }`（以及需要转发的 headers）处理对应 MCP 调用作用域。服务器复查该凭据属于当前账号及 Profile，不能指定其他账号凭据。客户端能力必须与实际调用一致。
- 自托管部署固定为 pgvector/pgvector:0.8.1-pg17；外部数据库须安装 pgvector >=0.8.0。迁移 0010/0011 保留原数组，扩展不可用时明确终止并给出修复步骤。

### 本地验证（2026-10-29）

- macOS、Node.js 24.17.0、pnpm 10.12.4；隔离容器 PostgreSQL 17.11 / pgvector 0.8.6，4 CPU / 8 GiB 配置（Docker 实际可用内存 7.75 GiB），x86_64 镜像。
- 冻结锁文件安装、服务端与前端类型检查通过。
- discovery + vectorSearch 专项 6 项通过，保持后端进程 60 秒硬超时。
- 初次测试因隔离容器端口与开发库冲突导致认证失败，未执行迁移。改为随机回环端口后迁移成功。第二次测试暴露 Drizzle 数组插值误生成 SQL record，改为参数化数组后通过；未放宽超时。
- 固定镜像首次及第二次在线拉取因 Docker Hub TLS 握手超时失败；本地验证使用已有 pgvector 镜像，不能据此宣称固定部署镜像验证通过。
- 独立基准：`node scripts/check.mjs 600 pnpm exec tsx scripts/benchmark-search.mts`，须指定隔离迁移库 DATABASE_URL。固定 10000 工具 / 1536 维 / 30 次热查询，合成聚类数据。另外使用 `scripts/benchmark-discovery.mts` 通过真实 HTTP 协议夹具测量授权、索引检查、Embedding、数据库检索及 JSON 序列化各阶段。合成数据不能代表真实 Embedding 供应商召回质量。

## 交付状态

四阶段主体已分别提交：搜索 `ca6b271`、指标 `97020a5`、CLI `70c84a5`、节选 `1dd68a9`。后续检索优化及索引维护 `1b1db78`、指标异常收尾 `9916600`、CLI 退出码验证 `435961f`、原文持久化与 Apps 回归 `8fa4646` 单独提交。

本地功能回归、生产构建、Go 和浏览器检查通过；性能及镜像结论见下文。真实 SSO、Embedding 供应商、模型任务和物理设备尚未验收。

此段原记录为当轮本地检查状态。上述代码现已进入 main；截至 `cae97a06e71bdb2ce28731b2b2d213d5c5c23e9c`，[平台 CI](https://github.com/yibaiba/mcp-platform/actions/runs/40873624569) 已成功完成。常规 CI 不执行此处万工具性能基准，不能替代性能门槛验收。本轮未发布或部署。升级前必须备份数据库、数据目录和加密密钥；回退恢复配套备份，不能假定旧程序兼容新授权数据。

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

## 最终本地验收（2026-10-29）

- 新建隔离数据库执行 0000–0017 全部迁移，再重复迁移通过。0015 优化 float8 数组内积解释器开销，0016 记录 HNSW 调用凭据以清理失效索引，0017 将维度元数据持久化为生成列，避免热检查反复读取大数组。没有手改生成迁移快照。
- 冻结锁文件离线安装、完整类型检查、ESLint 和生产构建通过。构建包含服务端、Web、CLI；保留现有 Vite 大 chunk 提示，没有放宽阈值掩盖告警。
- 首轮 19 组后端回归合计 273 项通过；补充故障收尾、CLI 业务失败退出码和 HNSW 实际 Agent 作用域检查后，最终 19 组回归 **276 项全部通过**。CLI/指标专项 8 项、搜索/共享专项 14 项、HNSW/发现专项 7 项亦通过；每个后端进程仍为 60 秒硬超时。异常保存、数据库错误和权限失败的错误日志属于断言中的失败路径，未作为成功业务结果处理。
- Go test（含 `-timeout 60s`）、Go vet、macOS/Linux/Windows 的 amd64/arm64 六架构交叉构建通过。真实 Pi SDK + pi-mcp-adapter 无模型发现与调用通过。
- Chrome 155 / macOS 实际登录隔离测试账号，确认搜索默认阈值 0.3、HNSW 参数 16/64/100；保存并重新打开长结果节选配置，确认默认关闭、32768/8192 字节及磁盘占用说明。
- CLI 使用真实浏览器确认，真实随机回环端口回调、令牌落盘和 `whoami` 成功。账号页撤销后同一 CLI 返回认证错误及退出码 3。浏览器证据保存在本机 `/tmp/mcp-search-qa/`。测试账号、数据目录与本机 HTTP 服务在验收后清理。
- amd64、arm64 应用镜像分别尝试构建，均因 Docker Hub 拉取 `golang:1.25-bookworm` 元数据时 TLS 握手超时失败。固定 PostgreSQL 镜像 `pgvector/pgvector:0.8.1-pg17` 三次拉取亦因 TLS 握手超时失败。两架构构建在元数据阶段失败，没有进入应用层编译。没有替换基础镜像或复用旧应用镜像宣称通过；本轮 Compose 与双架构镜像运行验收未完成。
- 首轮增补测试暴露凭据 UUID 与 text 比较错误，已显式转换并重跑通过。测试中的 PresentationService 访问方式修正为依赖注入实例，未改变生产服务暴露面。
- 权限监控初始化异常现在进入统一失败收尾，释放 lease 与活动计数；故障注入确认未派发上游。HNSW 目录更新复用物理索引，仅写入变更定义和删除已移除工具；重启将中断构建标为失败，并清理中断清理、删除账号/Profile、停用账号及失效凭据的索引。

### 性能验收

固定 10000 工具、1536 维、至少 30 次热查询，PostgreSQL 17.11 / pgvector 0.8.6，4 CPU / 8 GiB 限额（Docker 可用 7.75 GiB），shared_buffers=2GB、maintenance_work_mem=512MB。查询参数为 m=16、efConstruction=64、efSearch=100，严格迭代扫描。精确路径保持原始 float8[]，不转为 float32、不降维、不切换算法。

中间优化试验由最初精确检索 P95 3749 ms 降至 1539.7 ms；HNSW P95 33.9 ms、Recall@10 100%。额外尝试数组展开、分块和 SQL 表达式后没有得到进一步改善，未将更慢方案纳入代码，也未修改工具数量或验收阈值。最终复测见下表和[完整 30 次采样](benchmarks/search-2026-10-29.json)。

| 阶段 P95                |                精确模式 |                HNSW |
| ----------------------- | ----------------------: | ------------------: |
| 目录与授权检查          |                980.5 ms |            968.3 ms |
| 索引元数据检查          |                 57.2 ms |             81.6 ms |
| HTTP Embedding 协议夹具 |                  5.2 ms |              5.8 ms |
| 数据库检索              | **1423.7 ms（未达标）** | **36.7 ms（通过）** |
| 结果数组序列化          |                0.034 ms |            0.028 ms |
| 整体查询                |               2446.8 ms |           1242.5 ms |

HNSW 相对精确结果 Recall@10 为 **100%**，业务工具调用 **0 次**。各阶段独立取 P95，不能把这些分位数相加视为整体 P95。最终基准按精确检索未达标返回退出码 1；**本轮不能标记为满足全部交付条件**。当前剩余检索瓶颈为 float8 数组内积的数据库执行成本；未通过降精度、自动切换 pgvector 精确计算或增加 CPU 配额来改写成绩。

数据库检索目标仍是 exact P95 ≤1000 ms、HNSW P95 ≤300 ms、Recall@10 ≥95%。远程 Embedding 推理不计入检索阶段；HTTP 夹具仅验证协议、分阶段计时和执行零业务工具，不能替代真实模型质量验收。序列化计时测量结果数组 JSON 编码，不含 HTTP 信封及网络传输。

### 发布前仍需完成

精确检索性能门槛仍未通过；需在目标环境完成真实 SSO、Embedding、模型任务和物理设备检查。双架构镜像、Compose 和远程功能 CI 已在后续提交通过，代码已进入 main；这不消除本页保留的历史失败，也不表示性能达标。本轮未发布或部署。发布前备份数据库、数据目录和加密密钥；回退恢复配套备份。

维护范围：原有 ProfileService 和 InvocationService 超过 300 行。此次已将新增检索元数据、索引生命周期及阶段计时按职责提取到各自模块；调用服务保留依赖同一 lease/AbortSignal 的完整生命周期闭包，修复仅移动监控初始化到既有失败收尾范围，没有为行数机械拆分或改动无关调用行为。

## 2026-10-29 缺口复查

在 macOS x64、Node.js 24.17.0、新建隔离 PostgreSQL 17.11 / pgvector 0.8.6 容器中复测。保持 4 CPU、8 GiB 容器限额（Docker 实际 7.75 GiB）、shared_buffers=2GB、maintenance_work_mem=512MB，以及 10000 工具、1536 维、30 次热查询、原 float8[] 精度和检索门槛。

数据库检索基准 `scripts/benchmark-search.mts` 的精确 P95 为 **1932.0 ms（未达标）**，HNSW P95 **35.6 ms**，Recall@10 **100%**，因精确门槛返回非零。完整采样见 [复查数据](benchmarks/search-review-2026-10-29.json)。这次只报告数据库检索阶段，不与前表的端到端阶段混用。

在隔离库另试验数组展开、128/256 坐标分块和 SQL 聚合：未获得稳定达标结果；完全展开的 SQL 表达式触发 60 秒命令超时，已取消数据库内实验查询。所有实验函数/表仅存在于临时库，不加入迁移或产品代码，不通过降低精度、自动改用 HNSW 或放宽门槛掩盖失败。一次端到端基准尝试在 Embedding 夹具请求阶段失败，未得到有效成绩；后续数据库阶段复测独立执行。
