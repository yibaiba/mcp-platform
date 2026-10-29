# API、权限与协议

## 三种授权

- 平台登录：Better Auth cookie，`/api/v1/auth/*`；管理写操作需匹配 `Origin`。
- 外部 Agent：`Authorization: Bearer <接入密钥或 OAuth access token>`；入口 `/mcp/:profileId`。每次列目录、调用、读取和下载均重新检查当前授权及配置，撤销立即生效。
- 上游 MCP：官方 SDK OAuth，凭证绑定用户、连接与授权身份，加密持久化。Pi 连接由 Pi 管理 OAuth，彼此不互用 token。默认沿用连接账号；独立身份模式按接入密钥、OAuth grant 或 Pi 配置身份隔离。

创建配置时明确选择工具、Prompts/Resources/模板、Skill 版本和可下载的产物 ID；未选择的工具不能调用。标识由连接 ID 和原始工具名派生，两个同名工具不会误路由。内部 Pi 直接调用同一 InvocationService，不通过网关 HTTP 回环；调用记录包括执行位置、连接、设备和状态，不记录完整参数或输出。

外部配置可在管理页生成（密钥仅显示一次）：

```json
{
  "mcpServers": {
    "platform": {
      "type": "http",
      "url": "https://平台域名/mcp/配置UUID",
      "headers": { "Authorization": "Bearer 生成的密钥" }
    }
  }
}
```

外部入口使用官方 SDK 2.3.1 双栈处理 Streamable HTTP：现代 2026-07-28 请求使用每次请求的协议元数据，无需旧会话初始化；旧客户端初始化返回 `mcp-session-id`，后续携带会话 ID，DELETE 释放会话。两种入口使用相同配置授权。工具调用保留 MCP content、isError、structuredContent、annotations、outputSchema 和 `_meta`；超时、取消或设备断线可能已执行，显示“结果未知”，不自动重放。工具服务自己可能有其协议重试行为，不能据此承诺跨任意供应商的 exactly-once。

### 内容目录与通知

`GET /catalog` 返回当前用户可用条目，含 `id/connectionId/kind/name/locator/definition`；kind 为 `prompt/resource/template`。管理侧 `POST /catalog/prompts/:id/get` 接收 `{arguments:{参数名:"字符串"}}`；`POST /catalog/resources/read` 接收 `{uri:"mcp-platform://连接UUID/上游URI"}`。例如 `file:///shared.txt` 对外表示为 `mcp-platform://连接UUID/file:///shared.txt`。URI 保留原始内容，按连接隔离；Prompt 对外名称使用稳定条目 ID。返回的资源链接和嵌入资源一并使用该命名空间。

Agent 配置新增 `contentIds` 白名单；默认空列表，旧配置不会因此自动暴露新内容。资源模板授权覆盖匹配该模板的实际 URI，实际读取前后重新检查授权。目录分页全部读取，未广告对应能力的上游不发送该类请求。

tools/prompts/resources 的 `list_changed` 触发目录刷新后，按配置授权转发下游；`resources/updated` 仅发送给有权访问且订阅该 URI 的客户端。旧协议使用 `resources/subscribe`、`resources/unsubscribe`，现代协议使用 `subscriptions/listen` 的 `resourceSubscriptions`；平台引用计数避免一个客户端退订影响其他客户端。停止连接会关闭使用其资源订阅的下游入口，重新连接后需重新订阅；清理不会重新创建已停止的上游。配置变更和凭证撤销立即关闭关联入口，并取消运行中的工具或 Pi 任务。进度通知沿原请求的 progressToken 关联转发。

HTTP/stdio 上游使用 SDK 自动协商，SSE 固定旧协议；连接列表记录实际协议版本和上游 capabilities。stdio 自动协商可能由官方 SDK 启动一个短暂的独立探测子进程；探测不执行工具，但启动命令本身仍需适合重复启动。

Schema 使用官方 AJV 按 `$schema` 选择 draft-07、2019-09、2020-12；无效 Schema 在发现阶段明确失败，输入不合法不派发调用，输出不合法明确报告且不重放。合法布尔子 Schema 在旧客户端目录中等价转换为 `{}` / `{not:{}}`，数据库与现代客户端保留原定义；不修改 enum/default 等数据字段。已实现 Elicitation 与 Apps；仍不广告可选 MCP Tasks 扩展。交互中间结果不按最终工具输出 Schema 校验。

协议依据：[MCP 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28)、[TypeScript SDK v2](https://ts.sdk.modelcontextprotocol.io/v2/)。

## 管理接口 `/api/v1`

| 功能                    | 方法与路径                                                                                                                                                                                   |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 当前用户 / 可选模块状态 | `GET /me`                                                                                                                                                                                    |
| 设备                    | `GET /devices`、`POST /devices/pairings`、`POST /devices/pair`、`POST /devices/:id/re-pairings`、`DELETE /devices/:id`                                                                       |
| 连接                    | `GET/POST /connections`、`PATCH /connections/:id`、`POST /connections/:id/discover`、`POST /connections/:id/stop`、`POST .../wake`、`POST .../sleep`、`POST .../check`                       |
| 工具                    | `GET /tools`、`POST /tools/:id/call`（`{arguments:{...}}`）                                                                                                                                  |
| 内容目录                | `GET /catalog`、`POST /catalog/prompts/:id/get`、`POST /catalog/resources/read`                                                                                                              |
| Agent 配置              | `GET/POST /profiles`、`PUT /profiles/:id`（name/instructions/toolIds/contentIds/skillVersionIds/artifactIds）、`GET /profiles/:id/export?client=预设名`                                      |
| 接入密钥                | `POST /profiles/:id/keys`、`GET /profiles/keys/all`、`DELETE /profiles/keys/:id`                                                                                                             |
| 上游授权                | `GET /connections/:id/oauth`、`POST .../start`、`POST .../discover`、`GET .../callback`、`POST .../complete`（redirectUrl）、`DELETE .../oauth`                                              |
| Agent OAuth             | `POST /oauth/register`、`GET /oauth/authorize`、`POST /oauth/consent`、`POST /oauth/token`、`POST /oauth/revoke`                                                                             |
| OAuth grants            | `GET /oauth/grants`、`DELETE /oauth/grants/:id`                                                                                                                                              |
| Skills                  | `GET/POST /skills`、`POST /skills/zip`、`POST /skills/git`、`GET /skills/:id/export`、`POST /skills/:id/install`                                                                             |
| 产物                    | `GET/POST /artifacts`、`GET /artifacts/:id/content`、`POST /artifacts/transfers`                                                                                                             |
| 记录                    | `GET /calls`、`POST /calls/:id/cancel`、`GET /transfers`、`GET /installations`                                                                                                               |
| Pi                      | `GET/POST /tasks`、`POST /tasks/:id/cancel`                                                                                                                                                  |
| 导入                    | `POST /import/preview`、`POST /import/apply`（旧 mcpServers + 本地 deviceId；预览逐项返回 errors/warnings）                                                                                  |
| 分身份上游授权          | `GET /connections/:id/bindings`；`/connections/:id/bindings/:bindingId/oauth` 的 status/start/discover/complete/callback/revoke 与连接级操作相同                                             |
| OpenAPI                 | `POST /openapi/preview`；`GET/DELETE /connections/:id/openapi/oauth/:scheme`、`POST .../start`、`POST .../discover`、`GET .../callback`，也支持 `/bindings/:bindingId/openapi/oauth/:scheme` |
| 交互与续传              | `GET /interactions`、`POST /interactions/:id/respond`；接受、拒绝或取消后由原调用续传，重复响应返回明确错误                                                                                  |
| 事件流                  | `GET /calls/events`、`GET /tasks/events`，仅当前用户事件                                                                                                                                     |
| Apps 运行视图           | `GET /apps`（可选 taskId）、`GET/DELETE /apps/:id`、`POST .../call`、`POST .../read`、`POST .../message`、`POST .../context`、`POST .../send`                                                |

上游 OAuth 的浏览器 GET 回调在完成授权后只发现目录，再以 303 返回 WEB_ORIGIN 下对应的连接；平台直连、Pi 桥接及 OpenAPI 使用相同返回语义。POST complete 保留手动完成语义；POST discover 用于明确刷新当前身份的目录。回调需要当前账号会话，仍校验绑定、state 和重复提交，不执行业务工具。

平台启动失败或数据库失败不会回退到假数据。输入错误返回 `VALIDATION`；业务错误返回可诊断的 `code/error`；非预期异常返回 500 并记录服务端错误。

导入支持 `stdio`、`sse`、`streamable-http`/`http`，映射 `url/command/args/env/headers/cwd`。预览返回每项的 `name/config/needsDevice/errors/warnings/authorization`；缺少设备、URL 无效或传输不支持等错误不会隐藏其他声明。`warnings` 只列未映射字段名和原因，不返回这些字段的原始值；包括 `options`、`perSessionClient`、权限和 OAuth 的旧策略需要逐项核对。应用前会重新验证全部声明，存在错误返回 `IMPORT_INVALID`，不会部分创建。界面允许选择本地命令执行设备，修改原文或设备后需要重新预览。

`PI_ENABLED` 和 `/me`、`/health` 的 `piEnabled` 仅表示内置 Agent 任务是否启用。所有 MCP 连接（包括 Pi 桥接）的授权、工具发现和调用均不受此开关或模型配置限制；模型配置仅在 `POST /tasks` 时检查。

## MCP 传输与执行位置

| 执行适配器 | Streamable HTTP | HTTP + SSE（旧版） | stdio                  |
| ---------- | --------------- | ------------------ | ---------------------- |
| 平台直连   | 支持 HTTP/HTTPS | 支持 HTTP/HTTPS    | 平台主机子进程         |
| Pi 桥接    | 支持 HTTP/HTTPS | 支持 HTTP/HTTPS    | 平台主机 Pi 子进程托管 |
| 设备连接器 | 支持 HTTP/HTTPS | 支持 HTTP/HTTPS    | 所选设备子进程         |

连接的 `transport` 分别为 `http`、`sse`、`stdio`。HTTP/SSE 提供 `url`；stdio 使用 `mode: "managed"`，提供 `command`、`args`，可选 `env`、`cwd`，无需 URL。平台及 Pi 的 stdio 命令在平台主机执行，Docker 部署时位于 server 容器，设备适配器在所选设备执行。可执行程序必须已安装在实际执行环境。停止连接会关闭 MCP 会话和子进程。

stdio 的进程凭证通过 `env` 配置；上游 HTTP OAuth 端点不适用于 stdio，调用时明确返回 `OAUTH_NOT_APPLICABLE`。外部 Agent 的接入授权和工具权限对三种传输一致生效。Pi 使用显式 `httpTransport`，按用户选择连接；协议不匹配会报错，不静默切换成另一协议。

标准传输是 stdio 和 Streamable HTTP；HTTP+SSE 用于兼容旧版本。WebSocket、TCP 或 Unix socket 属于自定义传输，不能仅凭名称视为通用 MCP 兼容协议。参考 [MCP 传输规范](https://modelcontextprotocol.io/specification/latest/basic/transports)。

## OAuth

发现端点 `/.well-known/oauth-authorization-server` 和 `/.well-known/oauth-protected-resource/mcp/:profileId`。Agent OAuth 支持 public client、PKCE S256、精确 redirect/resource 绑定、一次性授权码、access token 1 小时、refresh token 30 天及轮换；同一会话刷新后使用新 token。登录用户须显式同意指定配置，客户端注册不等于获得授权。

上游授权使用官方 SDK 的发现与动态注册，也可预注册 `oauth.clientId/clientSecret/scope/tokenEndpointAuthMethod`，或配置 `clientMetadataUrl` 使用 Client ID Metadata Document。issuer、scope、认证方法、回调 state、凭证与刷新队列均按授权绑定隔离，刷新 access token 不更换身份。CSRF state 十分钟、一次消费；撤销后拒绝迟到的授权写入。设备 HTTP 授权的发现、交换与刷新在设备执行，平台仅通过受限设备授权通道协调；该通道不是通用 HTTP 工具。Pi 使用自己的文件凭证与授权执行路径。供应商侧已有授予仍需在供应商账户撤销。Cloudflare/Vercel 专项联调未以本地测试代替。

## 文件流转

`POST /artifacts` 发送原始二进制 body，附 `X-File-Name`（encodeURIComponent）、`X-Content-SHA256`（64 位小写 hex）。平台流式校验后才入库；不匹配删除临时文件并报错。

`POST /artifacts/transfers`：`{deviceId, direction:"send"|"receive", root, path, artifactId?}`。方向以设备为准：send 设备上传、receive 设备接收。平台签发十分钟单次令牌，仅绑定该传输和设备，URL 固定到平台源站。文件二进制不经过 WebSocket。

Agent 使用原接入密钥或 OAuth token 对 **`GET /mcp/:profileId/artifacts/:artifactId`** 发起授权下载。仅允许当前有效权限中的产物（长期授权或当前主体的临时授权），响应流带 Content-Length 和 X-Content-SHA256。把产物 ID、文件名和哈希交给 Agent，Agent 下载后再次核对哈希；该接口不把整个文件塞进模型上下文。

外部 MCP 与 Pi 共用 `platform_artifacts_catalog`、`platform_artifacts_read`。Profile 有已授权、可申请产物或 OpenAPI 工具时，目录提供这两个只读工具；可申请但尚未批准的文件不会出现在产物目录，也不能读取。读取参数为 `{id,offset,length,encoding?}`，offset/length 均以字节计；encoding 默认 `base64`，文本可选 `utf8`。无效或截断的 UTF-8 明确报错，不替换损坏字符。返回实际读取 length、总 size、encoding 与 data。目录中的 downloadPath 仍需携带当前 Agent 凭证；不签发公开下载令牌。身份和隔离方式见[外部 Agent 接入与隔离](external-agents.md)。

OpenAPI 二进制结果与其产生主体的读取授权原子入库。授权属于当前凭证或任务，一小时到期，任务结束、授权撤销、Profile 修订或绑定变化时失效；不会增加其他凭证的权限。调用开始时记录主体、Profile 修订和绑定，保存前重新检查，失败时清理未提交文件。授权可通过现有临时授权撤销接口管理。

## 连接器公开下载

`GET /api/v1/connector/install.sh` 和 `GET /api/v1/connector/install.ps1` 返回安装脚本文本；`GET /api/v1/connector/downloads/:name` 返回六种系统/架构的连接器或 `SHA256SUMS`。文件名固定为 `connector-{darwin|linux|windows}-{amd64|arm64}`，Windows 附加 `.exe`；其他文件名返回 404，缺少分发文件返回 `CONNECTOR_NOT_BUILT`（503）。

这些只读接口无需登录，便于尚未配对的目标电脑安装；响应不含账号、配对码或设备令牌。建立设备通道仍需一次性配对和设备凭证。构建和使用见[设备安装说明](connector.md)。

## 设备通道 v1

`WSS /api/v1/devices/channel`，Authorization 设备令牌；浏览器 Origin 不允许用于设备通道。主动出站，无需设备监听公网端口。

```json
{
  "v": 1,
  "type": "request",
  "id": "请求UUID",
  "method": "call",
  "deadline": "ISO-8601 UTC",
  "params": { "connectionId": "连接UUID", "config": {}, "name": "原始工具名", "arguments": {} }
}
```

method：discover/catalog/call/mcp.request/check/interaction.cancel/close/oauth.request/skill.install/artifact.send/artifact.receive。`catalog` 返回工具、Prompts、Resources、模板、服务说明、协议版本和 capabilities；`mcp.request` 的 params.operation 为 `{method,params}`，支持 prompts/get、resources/read、resources/subscribe、resources/unsubscribe。MCP 请求另含 sessionId/bindingId/capabilities/correlationId；旧连接器仍能处理原有请求，需要新能力时返回升级提示。设备响应 `{v:1,type:"result",id,result}` 或 `{v:1,type:"result",id,error:{code,message}}`；取消消息 `{v:1,type:"cancel",id}`。设备 hello 含 os/hostname/version 和能力列表；每 15 秒 heartbeat 报告服务状态；通道掉线三秒后重连，仅恢复连接，不重放请求。服务端心跳失联中断 pending 请求，明确标记结果未知。

协议源码：`packages/contracts/src/index.ts`、`connector/internal/agent/protocol.go`。自动化契约测试覆盖封包、真 WebSocket、两进程路由、取消和断线。

设备通知封包为 `{v:1,type:"notification",connectionId,method,params,requestId?}`，支持三类 list_changed、resources/updated 和 progress；进度的 requestId 必须关联同一 WebSocket 的 pending 请求。换代设备连接发来的旧消息不处理。设备断线后订阅随上游会话结束，客户端应在重连后重新订阅；不重放已派发的工具请求。

## Agent 工作空间、临时权限与交接

Profile 新增 `revision`、`requestable:{toolIds,contentIds,artifactIds}` 与 `connectionIdentities:{连接ID:"inherit"|"profile"|"credential"}`。更新携带当前 revision，冲突返回 `REVISION_CONFLICT`；旧请求省略新增字段时保留原值。`requestable` 只允许列申请目录及提交申请，不允许执行。Skill 版本仍使用长期授权。

`inherit` 沿用连接原有身份策略；`profile` 使用稳定 Profile 身份；`credential` 按接入密钥、OAuth grant 或 Pi 身份隔离。上游身份共享不等于运行会话共享。固定凭证只能保存到加密绑定，不能写入 Profile 或导出配置；独立身份缺少凭证时明确报错，不回落共享身份。连接的 `credentialHeaders`/`credentialEnv` 声明可按绑定覆盖的 HTTP 身份请求头或 stdio 凭证变量；OpenAPI 凭证按安全方案配置。保存固定凭证时携带绑定 revision。

| 功能                    | 方法与路径（均为 `/api/v1` 下）                                                                                               |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| 工作空间与影响预览      | `GET /profiles/:id`、`GET /profiles/:id/impact`                                                                               |
| 以 Agent 身份检查       | `GET /profiles/:id/agent/catalog`；`GET /profiles/:id/agent/connections/:connectionId`；`POST .../discover`、`POST .../check` |
| 以 Agent 身份调用与读取 | `POST /profiles/:id/agent/tools/:toolId/call`、`POST .../prompts/:entryId/get`、`POST .../resources/read`                     |
| 绑定固定凭证与影响      | `PUT /connections/:id/bindings/:bindingId/credentials`、`GET .../impact`                                                      |
| 审批与临时授权          | `GET /permission-requests`、`POST /permission-requests/:id/decide`、`GET /temporary-grants`、`DELETE /temporary-grants/:id`   |
| 持久任务与调用          | `GET /tasks/:id`、`GET /calls/:id`、`GET /workspace/events/:id`                                                               |
| 交接                    | `POST /handoffs/preview`、`GET/POST /handoffs`、`GET /handoffs/:id`、`GET .../export`、`POST .../execute`                     |

管理权限与 Agent 权限分别使用；带 Agent 路径的操作执行该 Profile 的实际权限，调用方不能通过 body 注入执行上下文。任务详情先返回持久快照，再用事件流触发重新读取；revision 单调递增，旧事件不会覆盖新状态。`GET /calls` 可按 profileId/taskId/connectionId/deviceId/toolId/status 筛选，toolId 使用目录中的稳定标识，区分不同连接的同名工具。诊断记录只保存标识、阶段与必要错误信息，不保存认证秘密。

开放 requestable 后，MCP 与 Pi 提供平台申请目录、申请及状态工具。申请绑定服务端确定的凭证或当前 Pi 任务；审批只能批准申请子集，默认有效期一小时，可显式调整。事务同时提交决定、授权和审计，重复审批不增加授权或延长时间。Pi 等待审批不占业务调用的网络超时，无隐式审批等待上限；任务取消、身份变化和凭证撤销会终止等待。批准只刷新可用工具并返回决定，业务必须由新调用执行。目录、调用、内容、订阅、Apps、交互续传及产物下载共同使用当前有效授权；长期授权仍有效时不因撤销临时授权而取消活动。

交接输入由用户选择 sourceTaskId、targetProfileId、targetRevision、summary、artifactIds、mode（pi/external），外部模式还需目标 Profile 的有效 credentialId。创建携带 idempotencyKey；预览不是授权凭证，保存和执行均重新核对内容来源、目标修订和权限。保存与执行分离，执行事务预留唯一任务；重复请求返回同一结果，失败保留状态，不自动重试。导出不调用模型，不含平台密钥、公开下载令牌、原始会话或 Apps 状态。外部产物入口仍需选定凭证鉴权；Pi 新任务通过 `platform_artifacts_catalog/read` 在当前任务权限内读取指定字节区间。

仅单进程维护运行调用、订阅与 Apps。撤销会结束依赖失效授权的活动，不能保证撤回已派发操作；未知结果明确记录，不宣称回滚或自动重放。

## 设备 HMAC 认证（连接器 0.3.0）

`POST /devices/pairings` 由管理会话生成十分钟一次性配对码。兑换 `POST /devices/pair` 接受 `{code, deviceId?}`，首次配对不传 deviceId，重配必须传原 deviceId；返回 `{deviceId, deviceSecret, credentialVersion}`，响应 `Cache-Control: no-store`。长期密钥仅此响应返回。重配码仅允许设备所有者通过带匹配 Origin 的管理会话调用 `POST /devices/:id/re-pairings` 生成，返回 `{code, expiresAt}`；事务递增版本、清除旧密钥、替换旧码，断开设备后返回。已撤销设备不可重配。

`GET /me` 的 `platformOrigin` 来自配置的 PUBLIC_URL 规范化源站，设备页以此生成配对命令；开发前端代理端口不会作为设备认证源站。`GET /devices` 使用字段白名单，增加 `credentialVersion`、`pairingRequired`；不会返回密文、密钥、MAC。迁移前的设备保留身份和资源关联，显示待重新配对。

设备在同一 `/api/v1/devices/channel` WSS 连接完成以下认证，禁止 Authorization 和 Origin 请求头：

1. 服务端发送 `{type:"auth.challenge",v:1,nonce,expiresAt}`，nonce 为 32 字节无填充 Base64URL；expiresAt 为 UTC ISO 字符串，30 秒到期。
2. 连接器发送 `{type:"auth.response",v:1,deviceId,credentialVersion,mac}`。密钥和 MAC 都为 32 字节无填充 Base64URL。MAC 输入是紧凑 JSON 的 UTF-8 字节：`["mcplatform-device-auth",1,platformOrigin,deviceId,credentialVersion,nonce,expiresAt]`。platformOrigin 为规范化的已配对平台源站，expiresAt 原样使用挑战字符串。共享测试向量位于 `packages/contracts/testdata/device-auth-vectors.json`。
3. 成功返回 `{type:"auth.success",v:1}`，注册通道，连接器发送原有 hello。失败统一返回 `{type:"auth.failure",v:1,error:"Device authentication failed"}` 后以 1008 关闭，客户端必须重新连接。超过 4 KiB 的认证帧在 JSON 解析前拒绝。挑战绑定连接，一次应答即消费；认证前不派发业务。

服务端以独立的 DEVICE_AUTH_ENCRYPTION_KEY 使用 AES-GCM 加密长期密钥，AAD 绑定所有者、设备 ID 和版本。单实例内认证完成/注册、重配及撤销按设备串行处理；凭证变更使用事务。机制遵循 [HMAC](https://www.rfc-editor.org/rfc/rfc2104.txt)；共享密钥要求服务端与本机都保护好密钥。该升级不改变 MCP 权限、固定凭证引用或一次性文件传输令牌。

## CLI 管理授权与索引管理

浏览器授权入口 `GET /api/v1/cli/authorize`、令牌兑换/轮换 `POST /api/v1/cli/token`。浏览器会话通过 `POST /api/v1/cli/consent` 确认；`GET /api/v1/cli/grants`、`DELETE /api/v1/cli/grants/:id` 管理当前账号授权；`POST /api/v1/cli/logout` 使用 CLI Bearer 撤销自身授权。管理范围分为 `management:read` 和 `management:write`，网页 Cookie 写请求继续校验 Origin。Agent key 不能管理平台，CLI 管理令牌不能直接执行业务工具。见[远程 CLI](remote-cli.md)。

`GET /api/v1/connections/:id` 和 `GET /api/v1/profiles/:id` 提供详情。搜索索引状态、显式重建及测试查询见[搜索说明](market-discovery-rest.md)。业务凭据可使用 `GET /mcp/:profileId/rest/tools` 和 `GET /mcp/:profileId/rest/tools/:toolId` 获取授权目录及定义。
