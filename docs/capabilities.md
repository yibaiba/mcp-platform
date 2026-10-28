# 身份、生命周期、OpenAPI、交互与 Apps

## 身份与目录

连接的 `identityMode` 默认 `shared`，继续使用连接原来的上游账号，不要求重新授权。`independent` 按接入密钥 ID、OAuth grant ID 或内置 Pi 配置身份建立授权绑定；token 刷新保持绑定，更换接入密钥形成新身份。连接页可查看并授权各绑定。

运行会话在绑定下继续按调用入口、客户端能力、下游会话和所选转发头隔离。现代协议使用平台执行上下文，不要求旧式会话 ID。目录快照按绑定、能力和转发头保存，工具 ID、Prompt ID 和普通资源 URI 保持稳定；尚未发现的独立身份没有其他账号的目录可用。

`forwardHeaders` 必须逐连接显式填写。接入 Authorization、Cookie 和协议控制头不能转发；上游认证来自绑定。静态配置头不在连接列表返回。转发头变化产生不同运行会话，HTTP Cookie 不跨身份复用。

## 连接生命周期

`lifecycle` 默认 `{startup:"eager",shutdownGraceMs:5000}`；未配置 idleTimeoutMs 时不自动休眠。`on-demand` 模式可从保存的目录列出工具，实际调用才唤醒，首次没有目录时可显式发现。并发唤醒合并，手动休眠后列目录不重新启动；显式执行或唤醒可启动。手动停止则拒绝调用，直至用户重新连接。

执行、读取、交互等待、资源订阅和 App 视图持有租约；忙碌时拒绝手动休眠。仅清理平台自己启动的进程：Unix 进程组、Windows Job Object，先正常退出，再在宽限期后结束托管后代；远程已有服务不会被终止。平台直连和 Pi 的 Windows stdio 使用随项目构建的 Go host，部署前须构建对应连接器。

`health` 默认 `{enabled:false,intervalMs:60000,timeoutMs:5000,recover:false}`。旧协议 ping，现代协议 server/discover；OpenAPI 来源不支持 MCP 健康检查，配置时明确拒绝。自动恢复必须单独开启，只重连和恢复必要订阅，失败工具不重放，停止的连接不被唤醒。

连接列表返回执行位置、默认授权归属、活动会话诊断与最近错误；编辑、唤醒、休眠、检查在连接页操作。健康状态和某次工具成功相互独立。

## 服务说明与客户端配置

保留上游 serverInfo、版本、图标、instructions。Agent 配置的 instructions 在前，按连接稳定顺序附加当前已授权服务说明并标明来源；外部入口与 Pi 使用同一结果。

配置导出从 PUBLIC_URL 生成 `/mcp/:profileId`。普通导出仅包含占位符（Codex 用环境变量，VS Code 用输入变量）；只有签发密钥的那次响应提供完整配置，数据库不保存明文接入密钥。14 种预设、CLI 和实际核对范围见 [客户端配置](client-configurations.md)。

## OpenAPI

独立来源 `source:"openapi"`，首版仅平台执行，不伪装成 MCP 传输。使用锁定的 swagger-parser 13.1.0；支持 OpenAPI 3.0/3.1 JSON/YAML，通过 URL 或当前用户已有产物导入。先预览操作、参数、原始服务地址、认证和不支持原因，再选择 `METHOD /path` 发布。baseUrl 是用户显式选择的统一执行地址，覆盖文档中所有服务器地址；工具标识由连接、方法、路径派生。

文档下载 headers 和逐引用 referenceHeaders 分开配置，只发送到显式地址；引用地址需在允许列表中。API 执行凭证独立于文档读取，跨源重定向不携带凭证，也不自动跟随。私网 URL 必须来自显式导入或连接配置，不执行文档脚本。

支持 path/query/header/cookie、JSON、URL 编码表单、multipart。文件用已授权 artifact ID，二进制响应保存为产物。API Key、Basic、Bearer、OAuth2 授权码/客户端凭证、OIDC 发现均按操作级 security 覆盖；AND 同时满足，多个 OR 方案要求显式选择，不自动挑第一个。授权码支持 PKCE；认证方法可选 basic/post/none。刷新按绑定串行，issuer 变化、scope 不足、失败刷新均报错，API 请求不重放。

不支持的版本、参数序列化、媒体类型或认证组合在预览标出具体操作，不能选择发布。预览返回的文档及认证配置也可能包含用户提供的信息，保存前应检查。

## Elicitation

form 和 URL 均需明确接受、拒绝或取消。URL 打开前确认；Pi 等待用户操作，模型不代填。现代工具结果保留 input_required/requestState/inputResponses，通过有效响应续传；旧 elicitation/create 中继到同一交互服务。无法关联父调用的旧会话串行处理交互，其他会话保持并发。

交互绑定调用、身份、连接和授权；响应与续传前复查。普通调用接口仍返回原工具结果；需要交互时返回等待状态，管理界面展示表单。外部客户端自己的交互在原客户端响应，平台界面标明归属。网络失败、重启、断开或撤权均中断等待，不自动续传。网络超时不计入用户等待；可在调用中指定 interactionDeadline，默认没有额外平台等待上限。

交互状态加密持久化用于诊断和中断标记，不能在重启后恢复工具。重复提交、超时后提交、撤权后响应明确拒绝。

## MCP Apps

锁定 ext-apps 2.0.3，MCP SDK 保持 2.3.1。外部入口转发 Apps 能力、UI 元数据与工具可见性；app-only 工具不注入模型。UI URI 为保持 ui:// 协议的连接命名空间；普通资源保留原兼容 URI。配置授权分别选择 UI 资源和相关工具，App 调用仍检查全部权限并记录。

工具测试页和 Pi 任务详情通过官方 AppBridge 初始化，传递参数、结果、主题、尺寸，支持关闭、取消和全屏。App 视图仅属于当前运行会话；刷新后显示结束，不通过重放工具恢复。App 关闭会取消其活动操作。ui/message 进入待发送列表，用户发送后才创建模型任务；上下文只关联当前 App/任务。工具测试页不宣告模型会话能力。

宿主从 `/_apps/sandbox` 读取可信代理 HTML，以 `data:` iframe 加载，使代理获得 opaque origin，再创建受 sandbox 属性和响应 CSP 限制的内层 iframe。宿主固定消息来源窗口及 `null` origin，代理校验父窗口 origin/source 和内层消息来源；App 无法读取平台 DOM、Cookie 或存储。摄像头、麦克风、定位和剪贴板权限当前不授予，若 App 声明要求会明确显示受限提示。

Apps 资源和管理接口共用后端的域名与端口；仅专用 frame 创建端点允许无凭证的 null-origin CORS，管理 API 不开放该来源。无需额外 Apps 域名或监听端口。部署步骤见 [部署说明](deployment.md)。浏览器与部署验证方法见 [测试说明](testing.md)。
