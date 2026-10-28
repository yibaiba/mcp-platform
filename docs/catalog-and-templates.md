# 生效目录与配置模板

## Profile 目录展示

「Agent 配置 → 目录展示」可选择稳定名称（旧配置默认）、上游原名或连接前缀，并为工具指定别名、工具/Prompt/Resource 描述。展示名冲突会报 `CATALOG_NAME_CONFLICT`，不随机改名。权限、审计、共享和 Skill 依赖仍使用内部 ID；上游调用始终使用原始工具名。

隐藏只支持顶层可选参数；必填字段、未知字段以及无法明确判断可选性的组合/依赖 Schema 会明确报错。隐藏字段从展示 Schema 移除，并在统一调用链拒绝传入（包括值为 `null` 的字段）。MCP、Pi、Apps 共用校验；目录刷新保留用户配置。Profile 更新发送目录通知并结束旧会话，后续连接取得最新目录。

## 模板格式

模板版本为 `1`。管理页面「配置模板」接受以下 envelope；CLI 和启动同步使用同一服务和格式：

```json
{
  "declaration": {
    "version": 1,
    "name": "team-tools",
    "connections": {
      "notes": {
        "config": {
          "name": "Notes",
          "adapter": "direct",
          "transport": "http",
          "mode": "existing",
          "url": "https://mcp.example.test/mcp",
          "headers": { "Authorization": { "secretRef": "notes-authorization" } }
        }
      }
    },
    "profiles": {
      "assistant": {
        "name": "Assistant",
        "tools": [{ "connection": "notes", "name": "search", "alias": "notes_search" }],
        "content": [{ "connection": "notes", "kind": "resource", "locator": "notes://help" }]
      }
    }
  },
  "mappings": {},
  "mode": "upsert"
}
```

工具引用使用原始工具名；Prompt 使用原始名称作为 `locator`，Resource/Template 使用原始 URI/URI 模板。工具条目可携带 `alias`、`description`、`hiddenParameters`。Profile 支持 `toolNaming`、按连接逻辑名配置的 `connectionAliases` 和 `connectionIdentities`，以及 `requestable.tools/content/artifacts`。

一份合法声明先整体落库，再解析实际对象。即使缺少秘密、设备、身份、目录或能力，也保存所有条目及 `pending/ready/error` 状态。待配置 Profile 的 Agent 接口返回 `DEPLOYMENT_PENDING`；更新声明尚未就绪时，旧权限不会继续用于调用。已发现且未变更声明的普通临时断网仍由连接状态表达。

初次创建/配置替换会尝试真实发现，不执行工具。发现完成、OAuth 完成、设备重新就绪及秘密配置变化后会继续解析。运行服务每 30 秒检查声明依赖和已保存目录；该检查不重放调用，也不持续重连普通网络失败。连接恢复仍由逐连接 `health.recover` 决定。停止的连接不会因模板检查而唤醒。

## 秘密及外部映射

- `secretRef` 只读取当前账号在「我的配置秘密」配置的加密值，不读取宿主机环境变量或文件。模板的 `env`、`headers`、OAuth clientSecret 和 OpenAPI 敏感凭证字段必须使用 `secretRef`。命令参数中的秘密也应显式写成 `{"secretRef":"..."}`。
- 连接 `deviceRef` 对应 `mappings.devices`。声明不能携带 deviceId 或设备秘密；目录使用 `directoryRef` 和 `mappings.directories`。
- 目录值使用 `{"directoryRef":"work"}`，由 `mappings.directories.work` 显式绑定绝对目录。平台执行时检查目录实际存在；设备执行目录由真实设备启动过程检查。
- Profile 的 `skills`、`artifacts` 是外部逻辑引用，分别映射为当前账号可用的 Skill 版本和产物；不会安装或猜测这些依赖。
- 接收共享使用连接声明 `{"sharedRef":"team"}` 与 `mappings.shares.team`；独立身份未配置时保持待配置，不借用所有者身份。
- 对外共享使用 `shares.<逻辑名>`，包含 `connection`、`recipientRef`、原始 `tools` 名称和 `content` 定位；`mappings.users` 显式指定接收账号，凭证模式默认 `independent`。

导出不包含 Agent key、OAuth token、授权会话或设备秘密。静态凭证改为 `secretRef`，目录和外部依赖改为逻辑引用，目标环境需配置映射。连接或 Profile 重名会明确要求先命名，不生成带随机 ID 的模板。

## 应用、冲突和清理

重复应用未变化声明保留对象 ID、版本、OAuth 状态和运行配置；声明替换按完整配置生效，省略的可选字段不会继承旧值。保存请求可携带上次返回的 `revision` 检测并发编辑。

人工修改受管连接、Profile 或共享授权会导致 `MANIFEST_CONFLICT`，预览显示冲突对象，应用不会覆盖人工编辑。默认 `upsert` 保留已从声明移除的对象。只有显式 `mode: "prune"` 才删除该 manifest 管理、且已从声明移除的对象；不删除其他人工创建的对象或接收到的共享来源。

管理 API：

- `GET /api/v1/config/export?name=platform`
- `GET /api/v1/config/manifests`、`GET /api/v1/config/manifests/:name`
- `POST /api/v1/config/manifests/preview`、`POST /api/v1/config/manifests/apply`
- `GET /api/v1/config/secrets`（仅名称及版本）、`PUT /api/v1/config/secrets`（`name/value`）

CLI 示例：`pnpm config:manifest apply operator@example.test ./config.json`。动作包括 `preview/apply/status/export`；后两者的最后参数是 manifest 名称。必须指定已有、启用的账号，不自动指定第一位用户。

启动同步设置 `CONFIG_MANIFEST_FILE` 和 `CONFIG_MANIFEST_OWNER`。文件由部署配置明确指定；容器内应将该 envelope 放入可读路径（例如 `/app/.data/config.json`）。模板内容本身不能要求服务读取其他文件。原 `mcpServers` 兼容导入入口保留。

## 本仓库验证

目录投影、模板生命周期与 review 回归通过本仓库测试验证，实际结果记录于 [能力迁移记录](eight-capabilities-progress.md)。供应商 OAuth 和远端设备联调仍需实际环境。
