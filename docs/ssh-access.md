# 用 SSH 接入已有 HTTP MCP

SSH 接入适用于目标电脑已运行 HTTP / SSE MCP、需要通过反向隧道让平台访问的情况。在“设备 → SSH 转发接入”管理记录。连接器 HMAC 通道及桌面客户端继续独立使用；SSH 接入不包含设备文件同步、Skill 安装或本机管理授权。

## 配置步骤

1. 在目标电脑启动原有 MCP，记录本机端口及实际路径，例如 `http://127.0.0.1:3000/mcp`。
2. 准备一个允许反向转发的 SSH 账号，将设备公钥加入该账号的授权文件。私钥只保留在设备上。
3. SSH 服务端使用 `GatewayPorts no`。建议为该账号设置 `AllowTcpForwarding remote`，并用 `PermitListen 127.0.0.1:13000` 明确允许的监听端口。无需向公网开放 13000。
4. 在平台“连接”创建平台执行、现有 HTTP MCP，URL 为 `http://127.0.0.1:13000/mcp`。保留实际 MCP 路径；SSE 对应选择 SSE 传输。平台连接的认证配置仍由原凭证绑定管理。
5. 在设备页添加 SSH 接入，填写 SSH 主机、端口、用户和**设备上的私钥路径**，选择该连接，设置本机端口 3000、远端端口 13000。一个接入可绑定多个 MCP。
6. Windows 下载连接包；macOS / Linux 可使用下述 OpenSSH 命令。隧道建立后点击“发现 MCP”，只有真实发现成功才显示 MCP 已连接。

SSH 服务端监听的 `127.0.0.1` 必须与平台进程处于同一网络空间。普通 Docker bridge 中的平台不能访问宿主机 loopback。现有单端口 Compose 不会自动改变网络配置；此类部署需将 SSH 转发服务放入平台容器的网络空间，或在 Linux 上明确安排同一 host 网络。不要为解决网络问题把转发端口开放到公网。

SSH 主机以小写域名 / IP 保存，同一主机、SSH 端口、远端监听端口只能绑定一次，MCP 连接也只能绑定一次。不同 DNS 别名是否指向同一服务器无法静态确认；实际端口占用由 OpenSSH 的 `ExitOnForwardFailure` 报错。

## Windows 连接包

解压 ZIP 到固定目录。包含 `connection.json`、`Connect-McpPlatform.ps1`、`Install-Startup.ps1`、`Uninstall-Startup.ps1` 和说明，不包含私钥、平台登录凭据或 MCP 授权头。

```powershell
# 首次核验主机指纹，允许交互解锁私钥；保持窗口运行，再到平台发现 MCP
.\Connect-McpPlatform.ps1 -Interactive
# Ctrl+C 结束首次验证后，注册当前用户登录任务并立即运行
.\Install-Startup.ps1
# 停止任务并取消登录启动
.\Uninstall-Startup.ps1
```

无人值守使用 `BatchMode=yes` 和 `StrictHostKeyChecking=yes`。带口令私钥需先由系统 ssh-agent 解锁；脚本不保存口令或绕过脚本执行策略。电脑必须保持登录、联网且未休眠。任务以当前用户的普通权限执行，多实例策略为 IgnoreNew。

`connection.log` 保存真实 SSH 错误、退出码及下次重连间隔。按配置间隔重新建立隧道，不启动 MCP 服务，不重放工具调用。修改连接包后需停止旧任务再启动；平台上的编辑不会远程修改已经解压的文件。

## macOS / Linux

替换实际用户、主机及端口，argv 中每个 `-R` 对应一个映射：

```sh
ssh -N -T -p 22 -l mcp -i ~/.ssh/id_ed25519 \
  -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes \
  -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
  -R 127.0.0.1:13000:127.0.0.1:3000 ssh.example.com
```

先通过可信渠道核验服务器指纹并写入 known_hosts。登录启动与进程管理使用该系统的原生服务管理器；本次迁移提供 Windows 自动启动包，未新增 Linux/macOS SSH 服务安装器。

## 状态、权限和撤销

平台没有 SSH 进程心跳，所以明确显示“隧道状态未上报”，不从 TCP 或 MCP 状态推断隧道健康。设备上的 `connection.log` 用于 SSH 排查，平台上的 MCP 状态与错误来自现有连接服务。连接 URL 被改成不匹配的端口后会显示配置错误，并拒绝生成过时的连接包。

SSH 接入只由所属账号查看、编辑、删除和下载。共享 MCP 的接收者仍按“共享授权 ∩ Profile 权限”使用工具，不获得 SSH 管理、连接包或私钥权限。连接目录、调用、凭证隔离和撤权沿用现有调用链。

删除 SSH 接入只删除平台记录，保留 MCP 连接。撤销访问需按实际意图停止本机隧道/启动任务、撤销 SSH 公钥，以及停止或删除平台 MCP 连接。删除 MCP 连接会移除其端口绑定，但不会停止设备上已经运行的 SSH。

平台连接后台恢复需单独启用 `health.recover`，默认不变。隧道断线时调用失败可能意味着上游已执行，平台不会自动重放；隧道恢复后只重新发现连接。

## API 与升级

账号管理凭证保护 `/api/v1/ssh-accesses`：GET 列表、POST 创建、PUT `/:id` 更新（必须携带 `revision`）、DELETE `/:id` 删除（JSON `{revision}`）、GET `/:id/windows-bundle` 下载。跨账号请求按不存在处理，冲突不泄露另一账号信息。

迁移 `0019` 新增 `ssh_accesses` 和 `ssh_bindings`，不修改旧设备配对。升级前备份数据库、数据卷、加密密钥；执行 `pnpm db:migrate`。回退恢复匹配版本备份。

可复现验证见 [测试说明](testing.md)。OpenSSH 本机夹具不能替代实际 Windows 设备的登录任务和远端 SSH 服务配置验收。
