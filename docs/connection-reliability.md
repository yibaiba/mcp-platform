# Python 运行环境、调用预算与后台恢复

## Python MCP

应用镜像包含 Python **3.13.9** 和 uv/uvx **0.9.5**。Python/uv 来源固定为官方多架构镜像索引
`ghcr.io/astral-sh/uv:0.9.5-python3.13-bookworm-slim@sha256:60d8ee2c1f7ffce050822adcb44907514e39f29d2d7b37732e8fca9f4f6113af`，索引包含 linux/amd64 和 linux/arm64。
安装方法参考 [uv 官方 Docker 指南](https://docs.astral.sh/uv/guides/integration/docker/)。

平台仍以 UID 1000 的 node 用户运行。运行缓存、工具环境和工具入口分别位于数据卷中的
`/app/.data/python/cache`、`/app/.data/python/tools`、`/app/.data/python/bin`。
stdio 子进程仅继承这些运行目录设置与既有安全环境变量，不继承平台数据库或加密凭证。

镜像不预装第三方 MCP 包。用户可以选择 `uvx`，以 argv 数组指定包的固定版本与参数；direct 和 Pi 均复用现有 stdio 管理、stderr 诊断和进程树清理。默认 `UV_PYTHON` 指向镜像自带解释器，`UV_PYTHON_DOWNLOADS=never` 禁止隐式更换解释器；如需其他解释器，用户可在连接 env 中显式覆盖。

## 连接配置

以下字段可用于创建连接或 PATCH `/api/v1/connections/:id`，管理界面的连接设置也支持编辑：

```json
{
  "connectTimeoutMs": 120000,
  "requestOptions": {
    "timeoutMs": 60000,
    "resetTimeoutOnProgress": true,
    "maxTotalTimeoutMs": 600000
  },
  "health": {
    "enabled": true,
    "intervalMs": 60000,
    "timeoutMs": 5000,
    "recover": true,
    "initialIntervalMs": 5000,
    "maxIntervalMs": 300000
  }
}
```

- 旧连接默认初始化和调用等待均为 60 秒，进度续期及后台恢复默认关闭，不要求重建连接。
- 开启进度续期必须显式提供 `maxTotalTimeoutMs`，且不小于 `timeoutMs`。
- 仅有限、非负、递增且不超过声明 total 的进度可以续期；重复进度不延长等待。
- 多轮交互共享执行预算；等待回答暂停预算。原有 `interactionDeadline` 仍独立限制用户等待截止时间。
- 超时与中断可能发生在上游已经执行之后，结果标为未知，不自动重放。DeviceBroker 传递剩余总期限，继续使用 Go 的 deadline/cancel；Pi 工具调用不再被内部固定 60 秒截断。

## 后台恢复

逐连接启用 `health.recover` 后，首次发现失败和闲置检测到的断线均可进入恢复。
恢复间隔按配置倍增，加入 20% 抖动，实际等待不超过配置的最大间隔；成功后尝试次数和退避归零。
没有隐含的最大尝试次数。配置、认证待处理等不可恢复错误保留为 `blocked`，需要修正配置或完成授权后显式连接。

恢复只建立连接、刷新真实目录、恢复仍有效的订阅。手动停止、休眠、配置替换、删除、身份失效及进程退出会清理相应恢复任务，不重放工具调用。
GET `/api/v1/connections` 返回每个运行会话的 `recovery`，包括状态、尝试次数、下一次时间与脱敏错误；UI 自动刷新此状态。
DELETE `/api/v1/connections/:id` 先关闭当前用户的连接与恢复任务，再删除配置；历史调用记录保留。

## 可复现检查

```sh
node scripts/check.mjs 60 pnpm exec vitest run tests/executionBudget.test.ts tests/recoverySchedule.test.ts tests/lifecycle.test.ts
node scripts/check.mjs 60 pnpm exec vitest run tests/connectionBudget.test.ts
docker build --target app -t mcp-platform:capabilities-stage1 .
node scripts/check.mjs 150 node scripts/verify-python-runtime.mjs mcp-platform:capabilities-stage1
```

Python 验收使用真实 Python MCP SDK 1.20.0（夹具固定兼容 Pydantic 2.12.3），分别在冷缓存联网和复用同一缓存且 Docker `--network none` 的环境中验证 direct/Pi；它不要求配置推理模型。测试使用临时卷，结束后删除该测试卷。
该测试验证所运行的镜像架构；多架构 manifest 检查不能代替另一架构完整应用镜像的运行验收。

## 当前仓库验收

本说明随独立仓库迁移第一阶段更新。验收结果以本仓库的测试和 CI 为准，不能沿用其他仓库的执行记录。

嵌入 Pi 的初始化等待由平台连接预算控制，父进程的 `connectTimeoutMs` 和取消负责结束等待及清理 worker。用于真实容器集成验收的 `PYTHON_VERIFY_TIMEOUT_SECONDS` 可显式调整，不改变后端单测进程的 60 秒硬超时。
