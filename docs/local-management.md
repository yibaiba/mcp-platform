# 本机 MCP / Skills 管理与同步

连接器提供独立本机管理页。管理已存在的配置和 Skill 文件，不安装软件、不运行 Skill 脚本、不调用模型。平台设备页通过现有设备通道管理目标电脑；浏览器不会访问另一台电脑的 localhost。

## 启动与首次纳管

```sh
pnpm connector:build
./connector/bin/connector-darwin-arm64 manage
# 已配对：同时启动本机页和平台通道
./connector/bin/connector-darwin-arm64 manage --offline=false --config /absolute/private/connector.json
# connect 保留首次配对并连接流程；run 保留后台连接流程
```

目标电脑只需对应系统的二进制，不需要 Node.js。终端打印 `http://127.0.0.1:随机端口/#open=...`；在本机浏览器打开一次，链接换取 HttpOnly / SameSite=Strict 会话，片段立即从地址栏移除。页面刷新使用该会话。连接器重启后端口与会话重新生成。不要转发打开链接；没有可用会话时重启连接器获取新链接。

无需配对即可扫描、搜索、编辑、连接或停止连接器会话、恢复修改前副本。`manage` 默认不与平台通信。无窗口后台同步可用 `connect` / `run` 携带 `--data-dir /absolute/path/to/local-state`（或配置 `localDataDir`）；不设置时保留原后台连接器行为。已配对时，即使平台掉线，本机管理仍可用。

1. 自动扫描用户目录；在“扫描源与项目”添加明确的项目绝对路径，或添加自定义配置文件 / 包含 Skills 的目录。
2. 查看错误、真实路径、客户端归属与内容。扫描只读文件和解析变量；不启动配置命令、不执行动态凭证表达式。
3. 勾选“纳入此设备与来源同步”。首次配对后，仅所选资源生成平台连接或不可变 Skill 版本。未选 Skill 内容不经设备通道返回平台。
4. 此后的单侧修改自动同步；平台“核对同步”可显式核对。双方修改时比较共同基线、本机和平台，选择一侧或编辑合并。
5. 纳管不会授予 Agent 权限。在 Agent 配置页明确授权工具、内容或固定 Skill 版本；内容更新不会修改旧版本授权。

本机清单位于 `~/.mcplatform/local`。可通过绝对路径参数 `--data-dir` 或配对配置中的 `localDataDir` 覆盖。未配对与已配对启动使用相同目录，选择与备份因此保留。首次连接会把该目录的同步选择关联到当前平台设备；切换平台设备须使用独立目录，避免把原设备选择隐式发送到另一目标。同一目录只允许一个连接器进程持有写锁。

## 客户端位置与语义

`~` 是运行连接器账户的 HOME。项目必须手动添加；连接器不会遍历整盘寻找项目。

| 客户端      | 用户 MCP                                                                                                                                | 项目 MCP                                                      | Skills                                      |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------- |
| Cursor      | `~/.cursor/mcp.json`                                                                                                                    | `.cursor/mcp.json`                                            | `.cursor/skills`、通用 `.agents/skills`     |
| Claude Code | `~/.claude.json` 的 `mcpServers`                                                                                                        | `.mcp.json`，以及用户文件 `projects[项目绝对路径].mcpServers` | `.claude/skills`、通用 `.agents/skills`     |
| Codex       | `$CODEX_HOME/config.toml`，默认 `~/.codex/config.toml`                                                                                  | `.codex/config.toml`                                          | `$CODEX_HOME/skills`、通用 `.agents/skills` |
| Pi          | `$PI_CODING_AGENT_DIR/{mcp,mcp-adapter}.json`，默认 `~/.pi/agent`；`$XDG_CONFIG_HOME/mcp/mcp.json`；`~/.agents/{mcp.json,mcp/mcp.json}` | `.mcp.json`、`.pi/{mcp,mcp-adapter}.json`                     | `.pi/skills`、通用 `.agents/skills`         |

JSON、JSONC、TOML 只局部修改所选条目，保留未改配置、注释与未映射字段。相同真实文件和 JSON Pointer 去重，保留多个客户端归属；不同文件同名资源保持独立。共享配置与覆盖层分别显示来源，编辑针对指定文件，不把合并后的整份客户端配置写回某个覆盖层。

支持 Cursor 原生 `${env:NAME}`、用户/项目路径变量；Claude `${NAME}` / `${NAME:-default}`；Codex `env`、`env_vars`、`http_headers`、`env_http_headers`、`bearer_token_env_var`；Pi 环境引用和 `~/` 路径。缺失变量、未支持的客户端字段、禁用条目、损坏配置逐项报错。Pi `!动态表达式` 不执行，标为需本机处理。未知语义保留可编辑，但连接器不冒充已经执行该客户端语义。

Skill 根目录符号链接显示真实目标，编辑作用于该目标；Skill 内部符号链接明确报错，需单独选择真实目标。`.system` 目录和显式标为只读的来源不能编辑或纳管。其他供应商管理目录请添加为只读来源。文件树支持 UTF-8 文本编辑、多文件导入、二进制择一和历史版本载入编辑器。保存现有文件时保留执行权限；新文件默认只限本机用户读写。

参考：[Cursor MCP](https://cursor.com/docs/mcp)、[Cursor Skills](https://cursor.com/docs/skills)、[Claude MCP](https://code.claude.com/docs/en/mcp)、[Claude Skills](https://code.claude.com/docs/en/skills)、[Codex MCP](https://learn.chatgpt.com/docs/extend/mcp)、[Codex Skills](https://learn.chatgpt.com/docs/build-skills)、[Pi adapter 配置](https://github.com/nicobailon/pi-mcp-adapter/blob/main/docs/configuration.md)、[Pi Skills](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/skills.md)。实际可执行语义以连接器报出的诊断为准。

## 同步、凭证和运行状态

平台只持久化所选条目的管理副本、来源元数据、同步基线与操作阶段，不上传整个客户端配置。MCP 的命令、参数、URL、环境变量、请求头等字符串转为 `local://资源ID/字段路径`；固定值和恢复副本留在本机。为避免遗漏含密参数，除 `type`、`transport`、`description` 外的配置字符串均在本机解析。涉及这些字段的编辑须在本机页完成。Skill 是用户选中的内容包，不自动清洗文件内容；纳管前应检查内容。

发现或调用时，设备读取当前来源并核对摘要，解析本机凭证；配置已改变而平台仍持有旧摘要时明确拒绝。专属身份必须在本机详情中用平台授权绑定 ID 关联所选本机资源，缺失时返回 `IDENTITY_CREDENTIAL_REQUIRED`，不继承共享账号。不会复制其他客户端 OAuth 登录态。原平台加密凭证连接继续兼容。

设备清单、文件摘要、幂等键和操作阶段均持久化。内容未变化不重复创建连接或 Skill 版本。双方变更形成资源级冲突；二进制文件择一。删除先进入待确认状态，确认后保存本机恢复副本再传播；解除同步保留两侧内容。操作记录可以恢复修改前副本，恢复前仍核对当前摘要。整份配置被删除时，只恢复所选条目，不恢复其他条目。

写入前复核来源和符号链接目标，采用同目录临时文件与替换。Skill 目录替换前保留 `.local-stage-*.previous`；崩溃后核对实际文件与操作阶段，已提交、未提交和外部修改分别显示成功、中断或冲突。不将失败显示为已同步，不重放工具业务调用。

状态含义分开显示：发现配置、启动程序存在、连接成功、已同步、Agent 已授权当前内容、客户端待重新加载。“连接 / 停止”只控制连接器持有的会话与进程，不接管客户端自己启动的进程。配置写入不代表客户端已经加载；没有实际客户端验证始终保留待重新加载状态。

## API 与升级

平台前缀 `/api/v1/devices/:id/local`，所有接口校验设备归属：

| 方法 / 相对路径             | 用途                                                                                                          |
| --------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `GET /`                     | 在线清单与绑定；离线时返回上次同步副本并明确提示                                                              |
| `POST /request`             | `state/resource/operation/scan/project.add/source.add/source.remove/select/edit/delete/start/stop` 等共享用例 |
| `POST /sync`                | `{operationId}`，返回持久操作，HTTP 202                                                                       |
| `POST /bindings/:bindingId` | `{revision,operationId,action:update/resolve/delete/unlink,...}`                                              |

本机 `/local-api/v1/session` 交换一次性令牌 / 读取会话，`POST /local-api/v1/request` 执行共享用例。它只监听 loopback，并校验 Host、Origin、SameSite 会话与 CSRF；平台管理登录不能替代本机会话。`backup`、`restore`、`identity.bind` 只允许本机页。所有写操作要求预期修订与幂等键，文件编辑还要求 `expectedDigest`。扫描和运行操作返回操作 ID，通过 `operation` 或同步记录查看进度；不占用业务调用等待流程。

平台迁移 `0018` 增加 `local_sources`、`local_bindings`、`local_operations`。升级前备份平台数据库和设备本机目录；执行 `pnpm db:migrate`，更新连接器。旧连接器原能力仍可用，打开本机管理会明确提示缺少 `local-management` 能力并要求升级。

## 备份与恢复

平台 `pnpm backup` 包含数据库里的脱敏副本、基线和操作记录，不包含设备固定凭证。停止连接器后，单独备份整个本机数据目录、所选配置和 Skill 来源，再恢复到原位置；保留权限及原配对配置。清单和 `backups/` 含本机原始值，必须按凭证文件保管，不上传平台、不提交 Git。Windows 还应通过用户目录 ACL 保护该目录。恢复后先打开本机页检查操作记录，再连接平台核对基线。

更换设备/平台应使用独立数据目录重新选择；不要改写已有清单的目标关联。恢复旧备份可能与当前平台内容冲突，必须按差异处理。客户端 OAuth 状态由原客户端管理，重新登录按其原生流程完成。

验证范围和未完成实机项见 [测试说明](testing.md)。
