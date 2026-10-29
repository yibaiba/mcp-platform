# 服务市场、智能发现与 REST

全部入口使用应用的同一端口（默认 4300）。现有 direct Profile 不需要模型；安装镜像不默认安装第三方 MCP 包。

## 官方服务市场

管理页面「服务市场」使用 [官方 Registry API](https://github.com/modelcontextprotocol/registry/blob/main/docs/reference/api/official-registry-api.md)，流程为搜索、版本详情、运行方式、执行位置、参数和秘密、预览、安装并连接。支持 npm、PyPI、Streamable HTTP 和 SSE；其他包类型显示原因。

预览将固定版本编译成 command 和 argv 数组，参数不会拼成 shell 命令。安装时重新读取声明并核对预览摘要；声明变化需重新预览。连接保存来源和版本；必须真实发现成功才显示「已连接」。下载、授权、启动失败保留连接及诊断状态，不能将保存成功当作连接成功。PyPI 可显式指定包提供的可执行文件名称。

`GET /api/v1/market/servers`、`/server?name=…&version=…`、`/versions?name=…`、`POST /preview` 和 `/install` 都需要管理登录。官方搜索的字符规则由 Registry 校验并返回错误。

## Profile 语义搜索

「智能发现」提供 `direct`（默认）和 `search`。搜索模式暴露 `platform_tools_search`、`platform_tools_definition`、`platform_tools_call`、已授权的钉选工具及现有权限工具。内部 Pi 使用相同发现服务。实际调用仍进入统一调用、隐藏参数验证和交互链路，使用内部稳定 ID。

Embedding 单独设置 OpenAI 兼容 `baseUrl`、`model`、可选 `dimensions`、`timeoutMs` 和 `batchSize`；`apiKeyRef` 只读取当前账号保存的秘密。配置与 Pi 推理模型无关。服务收到已授权工具的生效定义和查询文本；选择远程服务时这些内容会发送到该地址。

`searchOptions` 配置 `strategy`（exact/hnsw）、`minScore`（[-1,1] 或 null）及 `hnsw` 参数。新建 Profile 默认 exact、最低分数 0.3；已有 Profile 及省略该字段的旧模板保持不过滤。先按阈值过滤再取前 N 项，无匹配返回空数组。

精确模式保留 PostgreSQL `double precision[]`，数据库内完成计算、过滤、排序和 LIMIT，不限制模型维度。HNSW 使用独立作用域的 pgvector 物理索引，最多 2000 维，默认 m=16、efConstruction=64、efSearch=100；严格排序的迭代扫描仍属于近似检索，可能少于精确结果。未就绪时明确报错，必须显式重建，不自动切换策略。先取得当前权限与共享授权的交集以及当前身份的实际目录，再建立向量；作用域包括账号、Profile、身份、绑定版本、共享版本、客户端能力及模型配置。目录、模型或身份变更后，下次查询按新作用域或定义摘要更新；不复用其他身份的目录。索引并发构建返回 `SEARCH_INDEX_PENDING`；服务失败、维度错误等明确报错，不改用关键词搜索。返回检索结果前再次检查目录及权限。

搜索读取缓存，不唤醒停止或休眠连接。当前身份没有缓存时，只有该接收账号的来源服务仍连接着，才允许为当前客户端初始化真实目录；否则返回 `SEARCH_CATALOG_PENDING`，需显式连接和授权。搜索模式的初始化说明使用 Profile 自己的说明，避免为聚合上游说明唤醒服务。实际工具调用沿用现有唤醒流程。

`GET /api/v1/profiles/:id/context-footprint` 使用本地 `gpt-tokenizer` 的 `o200k_base` 编码估算最终定义，返回完整目录与当前暴露工具数、Token 数及 `estimated: true`。这不是模型账单，也不调用模型服务。

模板包含 `discoveryMode`、`searchOptions`、`resultPresentation`、`embedding` 和按连接逻辑名/原工具名引用的 `pinnedTools`；导出不包含 API 密钥。

管理界面提供索引状态、显式重建和测试查询。管理 API 使用 `GET /api/v1/profiles/:id/search-index`、`POST .../search-index/rebuild`、`POST .../search-test`。测试查询输入 `{ "query": "...", "limit": 10 }`，返回命中分数、数量、耗时、分阶段计时和 approximate 标志。重建仅处理目录及 Embedding，不执行业务工具。不同 Agent 凭据/客户端能力有独立索引；重建可传 `{ "credentialId": "Agent 凭据 ID", "capabilities": {} }` 指定实际 MCP 身份，REST 亦提供 `/mcp/:profileId/rest/search-index` 及 `/rebuild`。

## 长结果节选

`resultPresentation` 默认关闭。开启后，成功结果普通 text 总计超过 thresholdBytes（默认 32768）时，按内容块长度比例保留头尾，总计 retainBytes（默认 8192）字节。省略标记额外显示；不修改 structuredContent、媒体、资源、错误、交互或 Apps 原始结果。

平台先保存完整原始 JSON 产物并绑定当前调用身份，再返回节选。文本和 `_meta["platform/resultExcerpt"]` 包含原文产物 ID、大小、SHA-256、调用 ID、`platform_artifacts_read` 和认证下载路径。开启的 Profile 暴露原文读取工具；读取仍要求原调用身份及当前工具权限。原文文件占用磁盘，遵循已有产物授权有效期及清理规则。关闭仅影响新调用。

原文保存失败返回 `RESULT_ORIGINAL_SAVE_FAILED` 和调用 ID，明确说明上游可能已完成，不重放业务。REST 幂等重取使用同一已保存展示结果及原文，不重复创建产物。

## MCP → OpenAPI 与 REST

使用当前 Profile 的 Agent key 或 OAuth access token：

```text
Authorization: Bearer <profile-token>
GET  /mcp/:profileId/openapi.json
POST /mcp/:profileId/rest/tools/:toolId
GET  /mcp/:profileId/rest/calls/:callId
GET  /mcp/:profileId/rest/calls/:callId/result
POST /mcp/:profileId/rest/calls/:callId/answer
POST /mcp/:profileId/rest/calls/:callId/cancel
```

OpenAPI 3.1 的路径使用稳定内部工具 ID，`operationId` 使用生效展示名。工具 POST 的 JSON body 就是工具参数，不需再包一层 `arguments`。正常完成返回实际 MCP 结果，包括 `isError`、`content`、`structuredContent`；响应 `X-Call-Id` 标识原调用。

需要回答时返回 202、`callId`、`interactionId`、`inputRequests` 及 `links`。回答格式：

```json
{
  "interactionId": "<本轮交互 UUID>",
  "responses": {
    "<inputRequests 中的请求 ID>": { "action": "accept", "content": { "answer": "yes" } }
  }
}
```

支持 `accept/decline/cancel` 和 form/URL 交互。每轮交互有不同 ID；重复回答或旧 ID 返回 409。回答继续原调用，共用剩余执行预算，等待用户回答期间预算暂停。REST 不提供 Apps 渲染宿主，也不创建 Apps 会话；原始工具数据仍返回。

`Idempotency-Key` 绑定账号、Profile、原凭证和请求摘要。同一 key 和同一请求返回既有调用；key 相同但请求不同返回 409。并发请求只执行一次。失败、取消、重启中断及结果保存失败都不会触发重放。终态未知/失败返回 409，结果保存失败返回 500；只有执行中/等待回答返回 202。

状态、结果、回答、取消都匹配原账号、Profile 和凭证，并重新检查当前权限。另一个 Agent key 即便属于同一 Profile，也不能读取原调用。

完成结果以 AES-256-GCM 加密文件保存于数据目录 `rest-results/`，使用现有 `ENCRYPTION_KEY`，认证附加数据绑定调用身份；文件写入和目录重命名完成同步后才登记数据库摘要。数据库仅存索引和状态。备份必须同时包括数据库、数据卷与加密主密钥；回退恢复匹配版本备份。执行中或等待回答的调用在重启后标记结果未知，绝不恢复执行。

本仓库的实际验证结果记录于[八项能力迁移记录](eight-capabilities-progress.md)及[搜索/CLI/节选交付记录](search-cli-results-progress.md)；其他仓库的历史验收不代表本版本通过。
