# 内容库、MCPB 与分类节选

这三项能力参考 MCPHub 的功能范围，使用 MCP Platform 的账号、Profile、连接修订和产物权限实现；没有复制旧项目的控制器或全局配置。旧仓库保持只读。

## 与 MCPHub 的实现对照

| MCPHub 参考入口                                              | 迁入能力                     | 在 MCP Platform 中的处理                               |
| ------------------------------------------------------------ | ---------------------------- | ------------------------------------------------------ |
| `builtinPromptController.ts`、`builtinResourceController.ts` | 自建提示词与静态资源         | 账号私有内容库，复用 Profile、内容权限和逻辑模板       |
| `mcpbController.ts`、`McpbUploadForm.tsx`                    | MCPB 上传、解析、安装        | 分离预览与执行，增加执行位置、摘要目录、修订和操作回执 |
| `toolResultCompressionService.ts`                            | JSON/日志/搜索/diff 分类压缩 | 按现有字节预算节选，保留原文产物与当前读取权限         |

首版保留平台现有的鉴权、声明式配置、设备签名协议和结果产物契约，没有迁入 MCPHub 的管理员全局内容权限、按名称删除旧包目录或全局 Token 截断配置。

## 内容库

登录后打开“内容库”，选择 Prompt 或 Resource。Prompt 使用 `{{parameter}}` 占位符，并显式声明参数；仅做字面替换，不执行表达式。静态 Resource 使用 URI、MIME 类型和文本内容，HTML 按文本处理。名称和同类资源 URI 在账号内唯一，编辑和删除需要当前修订号，冲突返回 409。

保存的内容在 Agent 配置的内容目录中授权。内容本体加密保存，内部使用内置连接适配器复用已有 Profile、临时授权、MCP 目录和读取权限；不会创建网络连接或外部进程。改名保持内容 ID。删除会在同一事务中清理 Profile 的长期/可申请授权、目录展示及身份引用并递增修订；并发写授权必须确认内容仍存在。停用、删除和撤权后不能继续读取，并向相关客户端发送目录变化通知。内容库首版不提供跨账号共享授权。声明式配置导出包含内容和逻辑引用，导入其他账号时重新生成内部 ID。

接口位于 `/api/v1/library/prompts` 和 `/api/v1/library/resources`，支持 GET/POST 和带 ID 的 GET/PUT/DELETE；编辑及 DELETE 请求体包含 `revision`。`POST /api/v1/library/prompts/preview` 接收 `item` 和 `arguments`，不启动 MCP。

## MCPB 扩展包

在“连接”页面展开“导入 MCPB 扩展包”，上传后填写包声明的配置，选择平台直连、平台 Pi 或设备。预览展示目标平台展开后的命令、独立 argv、环境变量和目录，敏感值隐藏。上传和预览不执行程序。点击“安装并连接”后才校验并提取包、创建或替换连接、实际发现 MCP 工具；Pi 不调用模型。

解析遵循 [Anthropic MCPB 清单格式](https://github.com/anthropics/mcpb/blob/main/MANIFEST.md)。当前支持 manifest 0.1–0.3 的 Node、Python、binary 服务、平台覆盖、字符串/数字/布尔/路径配置、多路径 argv 及内置路径变量。拒绝不支持的 manifest 版本、ZIP64、重复路径、越界路径、链接及特殊文件。包按账号和 ZIP SHA-256 去重，安装目录按内容摘要隔离；已存在目录重新校验，不覆盖被修改的文件。依赖必须随包提供或已安装在执行位置，不执行隐式 npm/pip 安装。

清单的操作系统限制在预览时检查。`compatibility.runtimes` 在安装时对实际执行位置的明确 Node/Python 解释器运行 `--version`，按 SemVer 范围检查；不兼容、无效范围、未知运行时或动态包装命令无法确认解释器时明确失败。版本探测有 5 秒超时，不运行 MCP 脚本。设备需要 `mcpb-runtime` 能力。规则参考 [MCPB Compatibility](https://github.com/modelcontextprotocol/mcpb/blob/main/MANIFEST.md#compatibility)，Go 复用 [Masterminds SemVer v3](https://github.com/Masterminds/semver)，避免自建范围解析器。此检查证明解释器满足约束，不证明 npm/Python 业务包的实际运行版本；没有进程级证据时更新面板继续显示未知。固定版本不会自动替换。

设备安装使用现有签名通道，只允许设备所属账号发起；离线或不支持 MCPB 的连接器报错。平台填写的配置与其他设备连接一样保存在平台加密连接配置内。需要凭证仅留在本机时，使用连接器本机 Web 的“MCPB 扩展包”页，或桌面 MCP 页的“导入 MCPB（本机管理页）”：本机配置 AES-GCM 加密保存，远端请求不能设置、启动或读取这些本机凭证。本机保存不启动 MCP；若声明运行时约束会执行上述解释器版本检查。保存后作为 MCPB 来源出现在本机资源清单，选择同步后通过现有 HMAC 通道在平台创建本地引用连接，再由 Profile 显式授权。另点“连接验证”可在本机发现目录。客户端配置只包含连接器 `bundle-stdio` 入口、摘要和配置修订，不包含解密后的命令或凭证；CLI 和桌面程序均支持该入口。同一包已有本机配置时，页面明确提示替换，并校验预览时的修订；配置冲突需要重新解析和预览。配置变化关闭连接器管理的旧会话并使旧客户端入口失效；外部客户端需更新配置并重连。移除本机配置会删除加密配置并把资源标为已删除，但保留可能被平台安装共享的包文件。

替换平台连接需选择目标连接并提交当前修订号；不会自动回滚。每次预览对应一个操作 ID，同一操作重复提交返回原回执，不重复安装或创建连接；改变配置必须重新预览。平台重启把未完成安装标为结果未知，不重放。检查连接和目标目录后再决定是否创建新的安装操作。

接口：`POST /api/v1/bundles/mcpb` 上传 ZIP，`POST /:id/preview` 生成脱敏预览和摘要，`POST /:id/install` 接收操作 ID、预览摘要、执行位置、配置及可选连接修订，`GET /operations/:id` 读取本账号回执。`GET /api/v1/bundles/mcpb` 返回本账号包与安装历史；`POST /operations/:id/uninstall` 关闭并删除仍匹配安装修订的连接，清理 Profile 授权；连接已编辑或被新安装替换时拒绝操作。`DELETE /:id` 只清理无关联安装/连接使用的平台包文件，保留历史回执；相同字节可重新上传。设备文件不会被平台清理操作删除。刷新页面可恢复历史，运行中自动刷新，失败保存校验/解包/运行时/连接/目录阶段和脱敏错误码。旧记录缺少安装修订时，需在连接管理确认后手动删除连接。

## 分类结果节选

Agent 配置 → 智能发现 → 结果展示中可启用节选，并选择 `head-tail`、`auto`、`json`、`log`、`search`、`diff`、`text`。默认关闭；旧配置省略策略时保持首尾节选。原文先保存为受原调用身份和当前权限约束的产物，REST 重取不会重放上游调用。

JSON 保留预算内的顶层样本，日志优先错误及相邻行，搜索保留文件组，diff 保留带文件头的修改块。指定格式不匹配时保留原文并说明，自动模式无法识别时使用普通文本。媒体、structuredContent、错误和 Apps 保持原行为；没有模型调用。

## 升级与验证

迁移 0021/0022 增量新增内容索引、包和安装回执；0023 为安装历史增加阶段、时间、目标、连接修订及包清理标记，不重建已有连接和授权。升级前备份数据库、数据目录和加密密钥；本机包配置还需备份连接器数据目录及其中的密钥。此功能不触发 Release、镜像发布或部署。

专项：`pnpm test tests/library.test.ts tests/bundles.test.ts tests/bundlesDevice.test.ts tests/resultStrategies.test.ts tests/resultPresentation.test.ts`。每个后端进程保持 60 秒硬超时。浏览器入口为 `scripts/verify-management-browser.mts`，要求隔离数据库、Chrome 和环境提供的 Playwright，先构建平台、本机页面和当前系统 Go 连接器。它创建并清理专用账号和本机数据，不使用业务环境。
