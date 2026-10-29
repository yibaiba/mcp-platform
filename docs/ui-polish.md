# 工作空间界面优化

2026-10-29 本轮仅调整 Web / 本机管理页面和验收脚本，沿用现有组件与样式；没有增加依赖、数据库迁移或修改网络与授权 API。

- 内容删除、MCPB 卸载与包文件清理增加对象名称、授权影响及取消操作。
- 内容库区分加载、空记录与失败，失败可重试。提示词参数支持增删表单与 JSON 模式；预览当前未保存内容。切换内容、类型、站内页面及关闭页面时保护未保存草稿。异步预览返回时核对草稿，旧结果明确要求重新预览。
- 表单编辑后清除上次成功状态，提交期间禁用表单字段。
- 导航分为连接与设备、Agent 与内容、运行与管理；窄屏使用可滚动抽屉，账号与退出入口保持可见。
- 网络设置按通用代理、npm/Python 安装源、GitHub 加速分组；凭证操作紧邻地址，保留脱敏回显，固定保存区显示草稿状态及生效说明。
- 连接支持名称、地址、设备搜索，状态与执行位置组合筛选，空筛选可清除；MCPB、OpenAPI、MCP JSON 统一从“导入连接”进入。
- 版本检查突出状态、时间与来源，构建提交、包摘要和安装操作 ID 折叠展示，发布说明继续按纯文本显示。

## 可重复验收

在已迁移的隔离 PostgreSQL 上显式指定 `DATABASE_URL`，并先构建平台、本机页面及 Go 连接器。Chrome 和 Playwright 由验收环境提供，`PLAYWRIGHT_MODULE` 可以指向现有模块。

```sh
node scripts/check.mjs 180 pnpm build
node scripts/check.mjs 60 pnpm --filter web build:local
node scripts/check.mjs 60 go -C connector build -o bin/connector ./cmd/connector
node scripts/check.mjs 60 pnpm exec tsx scripts/verify-management-browser.mts
node scripts/check.mjs 60 pnpm exec tsx scripts/verify-ui-state-browser.mts
node scripts/check.mjs 60 pnpm exec tsx scripts/verify-network-browser.mts
```

本地 macOS / Node.js 24 三个浏览器脚本通过：覆盖草稿预览和请求竞态、取消与放弃修改、JSON 错误、删除和卸载确认、加载/失败/重试、手机导航、连接筛选、凭证回显、独立连通性结果、管理员/普通用户权限及发布说明 HTML 隔离。375/390px 页面没有横向溢出，截图输出至 `.data/management-browser-acceptance`、`.data/network-browser-acceptance`、`.data/ui-browser-acceptance`。交互使用隔离账号、协议夹具和本机 Go 进程；这些结果不代替物理设备或实际镜像源验收。

类型检查、ESLint、生产构建及 Go test/vet 本地通过。没有执行发布或部署，也没有接触业务数据库。
