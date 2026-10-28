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
