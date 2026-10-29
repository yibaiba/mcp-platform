# 原生桌面连接器

桌面端使用 MyGo v0.7.1 的 Native UI：界面由 Go 绘制，不启动 WebView，不需要 WebView2 或 WebKitGTK。构建使用 `CGO_ENABLED=0`，需要 Go **1.27.3+**。它与 CLI 共用配对、设备认证和 MCP 会话实现。CLI 仅在显式传入 `--data-dir` 或配置 `localDataDir` 时启用同一套本机资源管理；原有 CLI 默认运行行为保持不变。

## 构建与启动

在仓库根目录运行：

```sh
pnpm connector:desktop:build
```

构建无需 Node 前端编译；这里的 pnpm/Node 只运行跨平台构建脚本。产物位于 `connector/bin/desktop/`，包括六个目标的程序、macOS `.app`、Linux `.desktop` 文件和 `SHA256SUMS`。

## 单文件安装包与 GitHub Actions

初次准备打包工具，在仓库根目录运行 `pnpm connector:installers:setup`，随后运行 `pnpm connector:installers:build`。工具安装在忽略提交的 `connector/bin/tools/`；使用固定版本的 [nFPM](https://nfpm.goreleaser.com/docs/configuration/) 和 [NSIS](https://github.com/electron-userland/electron-builder-binaries/releases/tag/nsis-3.0.5.0)，NSIS 下载会校验 SHA-256。Linux amd64 构建机需安装 `p7zip-full`；本机完整打包需 macOS 的 `lipo`、`codesign`、`pkgbuild`、`hdiutil`，NSIS 的 macOS 主机程序为 x64，Apple Silicon 需要 Rosetta。

应用标识与本地构建默认版本维护在 `connector/packaging/metadata.json`；发布构建从 Release 标签（如 `v0.3.0` 或 `v0.4.0-rc.1`）读取版本，覆盖文件名及应用版本。Windows / macOS 的数字版本字段使用其中的 X.Y.Z 部分。安装包输出到 `connector/bin/installers/`，本机数据不打入安装包，卸载保留 `~/.mcplatform`：

| 系统                        | 安装包                   | 安装行为                                                                                          |
| --------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------- |
| Linux x64 / ARM64           | 各一个 `.deb` 和 `.rpm`  | 安装到 `/usr/bin/mcplatform-connector`，带应用菜单及图标，声明 GTK / GLib / AppIndicator 依赖     |
| Windows x64 / ARM64         | 一个 `windows-setup.exe` | 自动选择原生架构，默认装到当前用户 `LocalAppData/Programs`，提供桌面 / 开始菜单快捷方式和卸载入口 |
| macOS Intel / Apple Silicon | 通用 `.dmg` 和 `.pkg`    | DMG 拖入 Applications；PKG 安装到 `/Applications`，禁止重定位到其它同标识应用目录                 |

安装不会默认开启登录自启动。Linux 开启后写入 `$XDG_CONFIG_HOME/autostart/dev.mcplatform.connector.desktop`，默认目录为 `~/.config/autostart/`；这是登录图形桌面后启动。Windows 卸载只清理指向当前安装目录的登录启动项。

GitHub 工作流在仓库根目录 `.github/workflows/connector-installers.yml`，只在 Release 发布（`release.published`）时自动执行，普通 push 不触发桌面打包；涉及桌面代码和打包脚本的 PR，以及手动入口，只验证构建，不上传 Release 附件或推送镜像。六目标交叉编译、Go 测试、Linux 和 Windows 安装包都在 **Ubuntu amd64** 上完成；macOS runner 仅下载预编译 `.app`，运行原生工具合并通用应用并封装 DMG / PKG，不重复编译或安装 Go / nFPM / NSIS。最后由 Linux 汇总为 `connector-installers` artifact，附七个安装包及 `DESKTOP-SHA256SUMS`，保留七天，中间产物保留一天。发布触发时，七个安装包及 `DESKTOP-SHA256SUMS` 会上传到该 Release，重跑只替换同名附件；不会创建新的 Release。

拆分执行命令为 `pnpm connector:installers:build --targets=linux,windows` 与 `pnpm connector:installers:build --targets=macos --skip-build`。跨 job 的 `.app` 使用 tar 传递，保留可执行权限和目录结构。连接器构建缓存 Go 编译缓存和打包工具，不安装 Node 应用依赖。平台镜像仍由现有 `ci.yml` 独立验证与发布，桌面打包工作流不重复构建或推送镜像。

当前 macOS 应用使用 ad-hoc 签名校验包完整性，安装包没有 Developer ID 签名或公证，Windows 安装包也没有 Authenticode 签名；首次打开仍可能遇到系统信任提示。未把包结构校验、Linux 容器安装或交叉编译视为 Windows / 麒麟实机桌面与启动验收。

## 直接运行构建产物

图标源文件为 `connector/internal/desktop/branding/mark.svg`。构建脚本使用现有 MyGo 内存渲染器导出蓝底应用 SVG/PNG、彩色和单色托盘 SVG/PNG 及多尺寸 `.icns`，不增加 CGO 或外部图形工具依赖。macOS `.app` 在 `Contents/Resources` 中包含 `.icns` 并配置 `CFBundleIconFile`；运行时也会设置 Dock 图标，Windows/Linux 设置窗口图标。单独重新导出可在 `connector/` 运行 `CGO_ENABLED=0 go run ./scripts/icons`。

- macOS：使用对应架构目录里的 `MCP Platform Connector.app`，建议移至“应用程序”后启动。
- Windows：启动 `connector-desktop-windows-amd64.exe` 或 ARM64 版本，不会弹出控制台。
- Linux：把对应程序放到固定位置，并使 `.desktop` 中的 `Exec` 能找到该程序。模板使用程序文件名；可将程序安装到用户 PATH，或把 `Exec` 改为安装后的绝对路径（含空格时按 Desktop Entry 规则引用），然后把 `.desktop` 放入 `~/.local/share/applications/`。

也可直接启动并选择路径：

```sh
./connector/bin/desktop/connector-desktop-linux-arm64 \
  --config /absolute/private/connector.json \
  --data-dir /absolute/private/local \
  --ca-cert /absolute/private/platform-ca.pem
```

三个参数均可省略，也可在“设置”里选择。命令行显式值覆盖已保存的桌面设置。默认配置是 `~/.mcplatform/connector.json`；本机数据沿用 `~/.mcplatform/local`，配置中的 `localDataDir` 和显式数据目录仍然生效。桌面设置保存到 `~/.mcplatform/desktop.json`，登录启动会读取这些路径。

## 使用

1. 首次运行可直接离线扫描和管理本机资源。在平台设备页生成配对码，在“设备连接”填写平台地址和配对码。
2. 配对成功并保存凭证后自动连接。重新配对使用平台新生成的重配码，保留原设备及本机配置。
3. MCP、Skills 和扫描来源可在桌面端直接管理；操作记录可以载入修改前副本或确认恢复。编辑草稿在切换资源时保留；来源变化不会覆盖草稿，保存仍执行修订与摘要冲突检查。
4. 平台端的 Agent 授权、同步副本冲突处理和 Skill 版本管理继续在平台网页完成。凭证绑定在本机 MCP 详情中编辑。
5. 已配对设备每次启动自动连接。关闭窗口后驻留托盘；使用托盘的“显示设备连接器”恢复窗口，选择“退出连接器”关闭平台连接、MCP 会话及托管进程。托盘不可用时显示真实错误，关闭窗口会退出程序。

登录自启动默认关闭。在“设置”勾选“登录后自动启动并驻留托盘”后，由当前用户的登录会话启动：macOS 登录项、Windows Run 注册项、Linux XDG autostart。它与 CLI 的系统服务安装独立；不要让已有 CLI 服务与桌面端同时持有同一个本机数据目录。移动程序后重新设置登录启动。macOS 的登录项需要 `.app`。

桌面端为每个用户运行一个实例；再次打开会唤起已有窗口。数据目录另有跨进程写锁，已有 CLI 占用时会明确报错。

## 系统依赖与验收

无 CGO 指不需要 C 编译器参与构建，并不代表运行时没有系统动态库依赖。Linux 原生界面使用 GTK 3、GDK、GLib/GIO、Pango、Cairo、GdkPixbuf 和 OpenGL；托盘还需要 Ayatana AppIndicator 或 AppIndicator，以及桌面环境的托盘支持。缺库及托盘错误直接报告。

首版构建目标为 macOS、Windows、Linux 的 amd64/arm64；**不包含 loong64**。麒麟 ARM64 已提供的 GLib 2.64.6 / GTK 3.24.23 满足此前检查到的 API 下限，实际显示、输入法、OpenGL 与托盘仍需在该设备验证。

当前自动验证覆盖无 CGO 六目标构建、已有 Go 测试、认证状态、订阅通知、存储锁释放、原生界面导航和编辑草稿。界面测试使用 MyGo 的内存渲染器，不能替代 Windows/Linux/macOS 实机的托盘、中文输入法、登录启动和图形驱动验收。安装器及流水线验收见上文；发行签名、公证与三系统桌面实机验收仍未完成。

诊断日志位于 `~/.mcplatform/connector-desktop.log`，本机页会显示操作错误；日志和本机目录可能涉及本机路径或服务诊断，不属于平台备份。

## 本次迁移验收

迁移目标为独立仓库 `yibaiba/mcp-platform`。桌面程序、图标、配对和本机管理、平台同步接口、设备页管理入口及打包工作流在本仓库构建；没有修改 `mcp-manger` 工作区。数据库使用本仓库生成的增量迁移 `0018_blushing_punisher.sql`，不复制旧库的迁移编号。

本地验收使用隔离 PostgreSQL 17 / pgvector 测试库。六种桌面二进制、七个安装包以及 Go 测试/vet 已通过；平台同步回归检查真实 Go HMAC 通道、凭证脱敏、所有权、编辑冲突、断线核对及 Skill 版本保留。界面截图由 MyGo 内存渲染器生成并检查，不代表三个操作系统的真实桌面、托盘、输入法和登录自启动均已实机验收。安装器未签名/公证的限制仍适用。
