# Go 设备连接器

## 构建和配对

```sh
pnpm connector:build
./connector/bin/connector-darwin-arm64 pair --server https://平台域名 --config /absolute/private/connector.json
```

在管理界面生成配对码，粘贴到连接器提示；配对码十分钟内一次有效。连接器把设备 ID 和设备令牌写入新文件，已有文件不会覆盖。远程必须 HTTPS/WSS；只有 loopback 开发允许 HTTP/WS。平台撤销后设备不能再次认证，须重新配对。后台不会自动重放工具调用。

在生成的配置中设置实际可访问目录（替换为当前用户路径）：

```json
{
  "server": "https://平台域名",
  "deviceId": "配对产生的 UUID",
  "token": "配对产生的令牌，勿提交",
  "skillRoots": { "claude-user": "/Users/your-user/.claude/skills" },
  "artifactRoots": { "work": "/Users/your-user/MCPFiles" }
}
```

Windows 使用 JSON 转义路径，例如 `C:\\Users\\your-user\\.claude\\skills`；Linux 使用 `/home/your-user/.claude/skills`。文件路径必须在配置目录内，禁止上跳、绝对相对路径混用及子路径符号链接。配置权限是执行权限的归属：运行该连接器的本地账户负责启动进程与访问文件。连接配置支持命令和参数数组，不经过 shell 拼接。

```sh
./connector run --config /absolute/private/connector.json
```

“连接已有服务”只连接 URL；“托管启动”由连接器持有子进程，关闭连接会清理进程。stdio 必须托管启动。HTTP 托管服务需要自己准备好监听；启动尚未就绪时会显式报告连接失败，不用固定 sleep 掩盖启动问题，可在服务就绪后刷新。

## 自启动

安装时使用二进制和配置的绝对路径，移动二进制后重新安装。`install` 注册自启动；当前调试用 `run`。系统服务注册后通过系统服务管理器启动；卸载前先在系统管理器停止，再执行 `uninstall` 移除自启动，不删除配置。查看连接器终端或系统服务日志中的错误。

| 平台    | 后台服务                                                                                     | 需要桌面的应用                                                                                          |
| ------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Windows | 管理员终端 `connector.exe install --scope system --config C:\\...\\connector.json`，SCM 服务 | 当前用户 `--scope user`，任务计划程序 ONLOGON、交互会话；需要用户登录                                   |
| macOS   | `sudo ./connector install --scope system --config /.../connector.json`，LaunchDaemon         | `./connector install --scope user --config /.../connector.json`，LaunchAgent                            |
| Linux   | `sudo ./connector install --scope system --config /.../connector.json`，systemd              | `./connector install --scope user --config /.../connector.json`，systemd user；图形会话环境需由本机配置 |

Windows 不依赖 POSIX 文件模式保护配置，应在文件属性或 `icacls` 中只授予实际运行账户访问。系统服务不能替代登录会话访问桌面；自动化软件的权限、桌面会话、PATH/环境和应用安装必须在目标设备实测。管理界面显示 OS、主机名、心跳和各 MCP 服务状态，可定位设备离线与 MCP 错误。

## Skills 和文件

选择不可变 Skill 版本、Agent 配置、设备和 `skillRoots` 名称后安装。回滚也是安装指定旧版本。已管理目录被用户改动时报告冲突并保留内容；不会执行导入包内脚本。成功仅表示文件分发完成，返回 `reloadRequired: true`、`loadedVerified: false`。在 Claude Code 新会话中核对 Skill 列表，触发 Skill 并执行已授权 MCP 后，才能记录“实际加载成功”。

设备 A “发送文件到平台”返回产物 ID；设备 B “接收平台产物”通过一次性传输令牌流式下载并核对 SHA-256，目标文件已存在时报错而不覆盖。把最终产物 ID 加入 Agent 配置即可使用 [授权下载接口](api.md)。
