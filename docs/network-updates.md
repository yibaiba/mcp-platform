# 网络、安装源与版本更新

管理员在“网络与安装源”配置平台网络；设备桌面设置和本机 Web 的同名页管理该设备。平台默认设置不下发到设备。网络设置为空时使用原始来源，不内置或默认选中任何国内镜像和 GitHub 加速服务。

## 代理与凭证

HTTP/HTTPS 请求代理支持 HTTP 或 HTTPS 代理端点，HTTPS 请求代理留空时使用 HTTP 代理。`NO_PROXY` 支持主机、域名后缀、可选端口、IPv4、IPv6 和 `*`；IPv6 带端口写作 `[::1]:4300`。代理失败返回错误，不自动直连。

平台网络适用于 MCP、OpenAPI、上游 OAuth、Registry、Embedding、更新查询和新启动的相关子进程。保存后后续请求和新会话使用新配置，不重启现有 MCP/Pi 任务和子进程。配置切换会让旧连接池完成已有请求；服务退出会终止残留连接并释放连接池。

凭证单独填写，读取接口仅返回是否已设置。每项选择保留、更换或清除；保存携带修订号，冲突时重新读取。平台使用现有 Vault 加密保存在数据库；设备使用本机 `network.key` 加密 `network.enc`，不会上传设备网络配置和凭证。远程设备管理不允许读取或修改网络设置。

设备已连接的平台通道需要断开后重新连接。独立 CLI 进程与离线 `manage` 使用同一数据目录时，保存后重启 CLI 以加载设置；桌面及同一 `manage` 进程的新请求立即读取新设置，已运行工具保持运行。`pair`、`connect`、`re-pair` 同样读取设备数据目录的网络配置。

## npm / Python 来源

最终来源优先级：连接的 `packageSource` → 私有/非官方声明 → 配置的公共镜像 → 原声明或工具默认源。明确声明的官方公共源只有开启“替换明确声明的官方公共源”才替换。npm scoped registry、`.npmrc` 私有来源及其认证保留；认证信息按 registry 主机和路径匹配，不能转给公共镜像。

检查和启动共同解析静态 `npx`、`npm exec`、`uvx`、`uv tool run` 参数。npm 读取用户、项目和显式全局配置；uv 工具命令读取用户/系统 `uv.toml` 或 `UV_CONFIG_FILE`。多个候选包、动态命令和无法证明唯一来源的多个 Python 索引显示无法识别，并保留原执行声明，不猜测来源。市场预览显示最终来源；平台管理员文件中的凭证不会进入预览。

更新查询仅读取同一来源的元数据，不执行安装、启动 MCP 或调用模型。镜像缺包、滞后或认证失败按实际结果展示，不改用官方源。

## GitHub 加速

分别设置 API 基地址、下载模板和 Git 克隆模板。下载模板包含一个 `{url}` 或 `{encodedUrl}`；Git 模板使用 `{owner}` 和 `{repo}`，主机必须固定。界面显示示例改写地址，保存前校验。

API 配置用于 `yibaiba/mcp-platform` Releases；下载配置仅用于运行时明确的 GitHub 文件 GET/HEAD 请求（raw、归档、Release 下载）；OAuth 和 POST 不经文件加速，GitHub 请求体不会跨域重定向重放；Git 配置用于 Skill Git 导入，固定提交独立传递并保持不变。配置不影响 CI 依赖下载。

跨域改写和重定向不转发原始认证头、Cookie 或自定义认证头；端点如需认证使用独立令牌。携带认证查询参数的 GitHub URL 禁止转给第三方加速端点，错误明确返回。Git 禁止跟随 HTTP 重定向，避免 Git 凭证跨域传播。手动连通性检查分别报告 API、下载和 Git；Git 必须返回有效 HEAD，某一路成功不代表其他入口成功。

## MCP 包检查

连接所有者在编辑连接中手动检查，可为每条连接开启每 24 小时检查。共享接收者没有读取、检查或开启计划的权限。平台直连和 Pi 在平台检查；设备通过 HMAC 通道在本机查询，离线、撤权或缺少能力的旧连接器返回明确原因。

显示配置版本、可用稳定版本、实际来源、检查时间和可验证运行版本。没有独立运行包证据时运行版本为“未知”；配置固定版本、缓存存在和 MCP 自报版本不能证明实际运行版本。npm 使用 SemVer，Python 使用 PEP 440；预发布版本不作为稳定更新，未固定版本不会推断升级关系。

结果按账号、连接修订、包和来源隔离，相同并发检查合并。连接、来源和设备状态变化使已有结果过期；检查中配置变化拒绝保存旧结果。失败保留脱敏原因及标记过期的历史成功结果。计划默认关闭，不唤醒 MCP、不补跑重启期间错过的检查、不修改固定版本。

## 平台版本

“关于与更新”显示前后端共用的构建信息、GitHub Release 说明和设备连接器独立版本。登录用户可查看；管理员可手动检查或开启每 24 小时检查。检查只查询，不下载或升级、不发布产物。

`pnpm build` / `pnpm dev` 生成 `.build-info.json`。Release CI 注入 `PLATFORM_RELEASE_TAG`，其他构建为 `dev`；提交号取 `PLATFORM_COMMIT`、`GITHUB_SHA` 或 Git，构建时间为实际构建时刻。源码归档/Docker 构建无 Git 时须传完整 `PLATFORM_COMMIT`（已有本地构建信息可提供提交号）。前端从 `/api/v1/version` 读取同一份信息。

Release 查询支持条件请求、分页和缓存，区分尚未检查、暂无稳定 Release、失败、限流和可用更新。开发构建不推断自己落后于发行版。说明以纯文本展示，不执行原始 HTML；失败从不显示“已是最新版”。不存在 MCPHub 或 npm 平台版本回退。

## 接口与升级

- `/api/v1/admin/network-settings`：GET、PUT（修订保存）；POST `/check`。
- `/api/v1/connections/:id/package-update`：GET 状态、POST 手动检查、PATCH `{ "scheduled": true|false }`。
- `/api/v1/version`：登录用户读取。
- `/api/v1/admin/platform-update`：管理员 GET、POST、PATCH。
- 本机协议：`network.get`、`network.save`、`network.check`，远程调用拒绝；设备协议 `package.preview` / `package.check` 不上传本地网络凭证。

增量迁移 `0020_dark_chameleon.sql` 增加网络配置和更新检查表，不重建连接或授权。部署升级前按[部署说明](deployment.md)备份数据库、持久目录和密钥；设备同时备份原数据目录中的 `network.key` 和 `network.enc`。回退恢复升级前备份。此功能保持单域名、4300 端口和仅 `release.published` 发布产物的规则。

验收环境、失败修复和未完成的真实环境验证见[交付记录](network-updates-progress.md)。
