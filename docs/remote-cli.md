# 远程管理 CLI

CLI 通过平台 HTTP 接口操作，不读取服务器 `.env` 或直接访问数据库。首次从本仓库构建：

```sh
pnpm install --frozen-lockfile
pnpm --filter @platform/cli build
node packages/cli/dist/main.js env add production https://mcp.example.com
node packages/cli/dist/main.js login
node packages/cli/dist/main.js whoami --json
```

浏览器显示平台、当前账号和管理权限，确认后返回本机随机回环端口。已有邮箱和 SSO 登录均可使用。只读授权使用 `login --read-only`；不能启动浏览器时使用 `login --no-browser` 并手动打开终端中的地址。授权不会扩大账号角色或资源访问范围。

access token 有效期 1 小时，刷新令牌轮换且授权最长 30 天。凭据保存在当前操作系统用户配置目录，POSIX 文件权限为 0600。`MCP_PLATFORM_ACCESS_TOKEN` 可注入管理令牌；不会使用 Agent key 代替管理令牌。`logout` 撤销服务端授权后清除本地凭据；也可在平台“个人账号 → CLI 管理授权”中撤销。

## 环境和管理命令

`env add <name> <url>` 添加环境，`env use <name>` 切换默认环境，`env list` 显示配置。任何命令可用 `--env <name>` 临时选择环境。

| 命令                                                    | 参数与行为                                                 |
| ------------------------------------------------------- | ---------------------------------------------------------- |
| `connections list` / `get <id>`                         | 读取连接及状态                                             |
| `connections add` / `update <id>`                       | 用 `--file connection.json` 或 `--data '{…}'` 传入连接配置 |
| `connections connect <id>` / `stop <id>`                | 发现目录或停止连接；发现成功不代表业务工具执行成功         |
| `profiles list` / `get <id>`                            | 读取 Agent 配置                                            |
| `keys list` / `create <profile-id>` / `revoke <key-id>` | 明文密钥仅在 create 响应中输出一次                         |
| `config preview` / `apply`                              | 用 `--file request.json` 传入与管理 API 相同的请求体       |
| `config status [name]` / `export [name]`                | 检查声明式配置状态或导出配置                               |

声明式配置的请求体、秘密引用和预览/应用区别见[配置说明](catalog-and-templates.md)。所有命令支持 `--json`；直接运行构建入口可避免 pnpm 脚本提示混入 stdout。

## 业务工具与交互

业务命令要求明确的 `--profile <UUID>` 和 `MCP_PLATFORM_AGENT_TOKEN` 环境变量。管理授权不能直接调用业务工具。Agent token 应由调用环境安全注入，不要写入源码或提交到配置仓库。

```sh
node packages/cli/dist/main.js tools list --profile "$PROFILE_ID" --json
node packages/cli/dist/main.js tools describe "$TOOL_ID" --profile "$PROFILE_ID" --json
node packages/cli/dist/main.js tools call "$TOOL_ID" --profile "$PROFILE_ID" --file arguments.json --idempotency-key "$REQUEST_ID" --json
node packages/cli/dist/main.js calls status "$CALL_ID" --profile "$PROFILE_ID" --json
node packages/cli/dist/main.js calls result "$CALL_ID" --profile "$PROFILE_ID" --json
node packages/cli/dist/main.js calls answer "$CALL_ID" --profile "$PROFILE_ID" --file answer.json --json
node packages/cli/dist/main.js calls cancel "$CALL_ID" --profile "$PROFILE_ID" --json
```

等待交互时返回原调用 ID 和后续 answer 命令；answer 的 JSON 包含当前 `interactionId` 和按请求 ID 对应的 `responses`。取消与断线可能意味着上游结果未知，应检查原调用状态。变更和业务调用不自动重试；显式幂等重取复用同一次调用的已保存结果。

业务数据写 stdout，诊断及调用 ID 写 stderr。退出码：成功 0，参数错误 2，认证/权限错误 3，网络/服务错误 4，业务工具返回失败 5。等待交互的命令成功返回并不表示业务调用已完成。
