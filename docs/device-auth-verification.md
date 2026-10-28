# 设备 HMAC 升级

本次由用户确认升级 HMAC 并要求已有设备重新配对。迁移保留设备 ID 与连接引用，旧 token 不再用于认证。生成并备份独立的 `DEVICE_AUTH_ENCRYPTION_KEY`（32 字节 Base64），与应用和 Go 连接器一起升级。

设备页提供重新配对入口；生成重配码立即撤销旧凭证，连接器 `re-pair` 原子更新本地配置。详细步骤见 [连接器说明](connector.md)。

本仓库测试与实际环境验收结果记录于 [能力迁移记录](eight-capabilities-progress.md)，尚未执行的检查不视为通过。
