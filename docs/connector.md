# Go 设备连接器

## 原生桌面端

需要窗口、托盘、本机 MCP/Skills 管理时，使用[桌面连接器](connector-desktop.md)。macOS、Windows 和 Linux 的安装包随本仓库 Release 发布；桌面端使用同一 HMAC 设备通道。已有 CLI 配置可在桌面端设置中选择，使用相同设备时先停止 CLI 进程。

## 在目标电脑安装和连接

目标电脑无需预装 `connector`、Go 或 Node.js。在平台“设备”页填写电脑名称并生成配对码，选择目标系统，点击“复制安装连接命令”，粘贴到目标电脑终端执行。安装脚本从当前平台下载匹配系统和架构的可执行文件，校验 SHA-256 后直接启动；终端提示时粘贴配对码即可。

- macOS/Linux 使用 `sh`、`curl` 和 `shasum` 或 `sha256sum`，自动识别 x64/ARM64，默认安装到 `~/.local/share/mcp-platform/connector/`。
- Windows 使用 PowerShell，自动识别 x64/ARM64，默认安装到 `%LOCALAPPDATA%\MCPPlatform\Connector\`。
- 配对配置保存在安装目录的 `connector.json`。再次执行安装连接命令会更新可执行文件并复用配置；不会清空设备凭证或目录配置，也不会自动注册登录自启动。
- 需要分开安装到不同目录时，在执行前设置 `MCP_PLATFORM_CONNECTOR_HOME`。单独运行安装脚本时可用 `--install-only`（Windows 为 `-InstallOnly`）只下载校验，不启动或配对。

平台须能从目标电脑通过 HTTPS 访问；`localhost`/`127.0.0.1` 只适用于平台所在电脑的本机开发。设备页会提示本机地址的影响，不会自动猜测局域网地址或更换平台。安装程序和六种可执行文件由平台自身的 `/api/v1/connector/` 提供；公开下载接口不包含任何账号、配对码或设备令牌。校验失败、下载失败和缺失构建文件均明确报错，不会继续安装或报告成功。

“手动下载连接器”也提供六种文件及 `SHA256SUMS`。手动下载后使用相应二进制的完整路径执行 `connect`；命令不要求文件已经在 PATH 中。目前不通过 npm 分发，无需使用 `npx`。

## 平台管理员：构建分发文件

Docker 服务端镜像会在独立 Go 构建阶段生成并打包六种系统/架构的连接器。源码运行平台时，管理员在启动前执行 `pnpm connector:build`；目标电脑不执行此构建命令。缺少文件时下载接口返回 `CONNECTOR_NOT_BUILT`（503），提示管理员构建或更新镜像。

## 手动构建和配对

```sh
pnpm connector:build
./connector/bin/connector-darwin-arm64 connect --server https://平台域名 --config /absolute/private/connector.json
```

在管理界面“设备”中生成配对码，粘贴到连接器提示；配对码十分钟内一次有效。`connect` 首次配对保存配置后立即连接；以后运行同一条命令复用原配置，不需要配对码，也可以省略 `--server`。终端保持运行，退出后设备离线。原有 `pair`（仅配对）和 `run`（仅启动）仍可用。

连接器把设备 ID、deviceSecret 和 credentialVersion 写入新文件，已有文件不会覆盖。已有配置无效或 `--server` 与原平台不同时明确报错，不会暗中重新配对。需要连接另一个平台时选择另一份配置路径。远程必须 HTTPS/WSS；只有 loopback 开发允许 HTTP/WS。平台撤销后设备不能再次认证，须重新配对。后台不会自动重放工具调用。

设备列表中的“添加本机工具”会预选这台设备和 stdio。填写 MCP 启动命令及参数，保存后到“MCP 连接”点击“连接”发现工具，再在 Agent 配置中选择权限。设备在线只表示传输通道已接通，不表示桌面或浏览器已经可操作。

文件/终端、浏览器自动化、整机桌面均由目标电脑上实际安装的 MCP 提供，连接器负责启动和转发；本项目尚未内置安装这些工具。桌面 MCP 必须兼容目标系统并运行在登录的图形会话中；macOS 通常需要工具要求的辅助功能和屏幕录制权限。浏览器是否使用新配置文件或已有登录状态由所选浏览器 MCP 决定。三类能力需分别验证，传输协议测试不能代替真实电脑控制验收。

在生成的配置中设置实际可访问目录（替换为当前用户路径）：

```json
{
  "server": "https://平台域名",
  "deviceId": "配对产生的 UUID",
  "deviceSecret": "配对产生的32字节无填充Base64URL密钥，勿提交",
  "credentialVersion": 1,
  "skillRoots": { "claude-user": "/Users/your-user/.claude/skills" },
  "artifactRoots": { "work": "/Users/your-user/MCPFiles" }
}
```

Windows 使用 JSON 转义路径，例如 `C:\\Users\\your-user\\.claude\\skills`；Linux 使用 `/home/your-user/.claude/skills`。文件路径必须在配置目录内，禁止上跳、绝对相对路径混用及子路径符号链接。配置权限是执行权限的归属：运行该连接器的本地账户负责启动进程与访问文件。连接配置支持命令和参数数组，不经过 shell 拼接。

```sh
./connector run --config /absolute/private/connector.json
```

“连接已有服务”只连接 URL；“托管启动”由连接器持有子进程，关闭连接会清理进程。stdio 必须托管启动。HTTP 托管服务需要自己准备好监听；启动尚未就绪时会显式报告连接失败，不用固定 sleep 掩盖启动问题，可在服务就绪后刷新。

使用私有 CA 的平台可在 `pair`、`re-pair`、`run` / `connect` 时显式添加 `--ca-cert /absolute/path/to/ca.pem`。此证书只加入当前进程的信任池，保留系统根证书及主机名校验；文件缺失或无有效 PEM 证书会报错，不修改系统钥匙串。后台服务需要私有 CA 时，使用系统信任库安装该 CA。

## 设备认证与重新配对

0.3.0 与服务端一起升级，不兼容旧设备 Bearer 协议。每次 WSS 连接先接收 30 秒有效、仅当前连接可用的挑战，使用 HMAC-SHA256 应答，服务端成功后才注册业务通道。平台源站来自已配对的 `server`，服务端使用配置的 PUBLIC_URL，不信任转发头。DNS 主机名使用小写、去掉默认端口，IPv6 使用压缩形式；国际化域名建议使用平台地址的 ASCII/IDNA 形式。认证失败会明确记录，自动重连取得新挑战；不会重放业务请求。

在设备页点击“重新配对”，确认后**立即断线并使旧密钥失效**。设备 ID、连接与目录配置保留。重配码十分钟有效、单次使用；再次生成使上一枚失效。未兑换或过期后设备保持“待重新配对”。

```sh
connector re-pair --config /absolute/private/connector.json
# 配置遗失时必须明确指定原设备：
connector re-pair --config /absolute/private/connector.json --server https://平台域名 --device-id 原设备UUID
```

粘贴重配码，成功后重启连接器。命令原子替换凭证并移除旧 `token`，保留其余配置字段。兑换成功但本机保存失败会明确报错并提示设备 ID；服务端无法再次取回长期密钥，须在设备页生成新重配码再执行命令。

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
