import { and, eq, inArray } from 'drizzle-orm';
import { connections, devices, type Database, type profiles, type tools } from '@platform/db';
import { requireValue } from '../../shared/errors.js';

export async function describeTools<T extends typeof tools.$inferSelect>(input: {
  db: Database;
  profile: typeof profiles.$inferSelect;
  catalog: T[];
}) {
  if (!input.catalog.length) return [];
  const rows = await input.db
    .select({
      id: connections.id,
      name: connections.name,
      adapter: connections.adapter,
      deviceId: connections.deviceId,
      deviceName: devices.name,
    })
    .from(connections)
    .leftJoin(
      devices,
      and(eq(devices.id, connections.deviceId), eq(devices.ownerId, input.profile.ownerId)),
    )
    .where(
      and(
        eq(connections.ownerId, input.profile.ownerId),
        inArray(connections.id, [...new Set(input.catalog.map((tool) => tool.connectionId))]),
      ),
    );
  const sources = new Map(rows.map((row) => [row.id, row]));
  return input.catalog.map((tool) => {
    const source = requireValue(sources.get(tool.connectionId), '工具所属连接不存在');
    const location =
      source.adapter === 'device'
        ? (source.deviceName ?? source.deviceId ?? '尚未选择设备')
        : '平台服务器';
    const identity = {
      profile: 'Agent 专属身份',
      credential: '按调用凭证隔离',
      inherit: '沿用连接身份配置',
    }[input.profile.connectionIdentities[tool.connectionId] ?? 'inherit'];
    return {
      ...tool,
      definition: {
        ...tool.definition,
        title: tool.definition.title ?? `${tool.name} · ${source.name}`,
        description: [
          tool.definition.description,
          `平台执行上下文：原工具 ${tool.name}；连接 ${source.name}；运行位置 ${location}；身份方式 ${identity}。`,
          '上游服务或设备的本地路径不保证在当前客户端可读；跨设备文件请使用已授权产物。',
        ]
          .filter(Boolean)
          .join('\n\n'),
      },
    };
  });
}
