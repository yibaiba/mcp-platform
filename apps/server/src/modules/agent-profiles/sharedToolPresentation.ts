import type { tools } from '@platform/db';
import type { ConnectionService } from '../mcp/connectionService.js';

/** Resolve only the recipient's effective context; never expose the owner's device metadata. */
export async function describeSharedTools(input: {
  ownerId: string;
  connections: ConnectionService;
  catalog: (typeof tools.$inferSelect)[];
}) {
  const ids = [...new Set(input.catalog.map((tool) => tool.connectionId))];
  const contexts = new Map(
    await Promise.all(
      ids.map(async (id) => [id, await input.connections.context(input.ownerId, id)] as const),
    ),
  );
  return input.catalog.map((tool) => {
    const context = contexts.get(tool.connectionId)!;
    const delegated = context.credentialScope?.ownerId !== input.ownerId;
    const location = context.config.adapter === 'device' ? '所选设备' : '平台主机';
    return {
      ...tool,
      definition: {
        ...tool.definition,
        title: tool.definition.title ?? `${tool.name} · ${context.config.name}`,
        description: [
          tool.definition.description,
          `平台执行上下文：原工具 ${tool.name}；共享连接 ${context.config.name}；执行位置 ${location}；${delegated ? '经明确授权使用来源凭证或设备' : '使用接收者独立身份'}。`,
          '共享连接不授予设备管理、文件同步或 Skill 安装权限。',
        ]
          .filter(Boolean)
          .join('\n\n'),
      },
    };
  });
}
