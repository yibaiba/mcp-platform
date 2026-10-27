import { z } from 'zod';
import type { ContentAccess, ContentService } from '../mcp/contentService.js';

const names = ['platform_mcp_catalog', 'platform_mcp_prompt', 'platform_mcp_resource'] as const;
const textResult = (result: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(result) }],
});
export async function contentToolset(content: ContentService, access: ContentAccess) {
  const entries = await content.catalog(access);
  const requestable = access.profileId ? (await content.requestable(access)).length : 0;
  const tools =
    entries.length || requestable
      ? [
          {
            name: names[0],
            description:
              '列出当前 Agent 配置允许访问的 MCP Prompts、Resources 和资源模板，获取提示词 ID 与资源 URI。',
            inputSchema: { type: 'object' as const, properties: {} },
          },
          {
            name: names[1],
            description: '按 platform_mcp_catalog 返回的提示词 ID 获取 Prompt。',
            inputSchema: {
              type: 'object' as const,
              properties: {
                id: { type: 'string' },
                arguments: { type: 'object', additionalProperties: { type: 'string' } },
              },
              required: ['id'],
            },
          },
          {
            name: names[2],
            description: '按 platform_mcp_catalog 返回的资源 URI 读取 Resource；模板需替换变量。',
            inputSchema: {
              type: 'object' as const,
              properties: { uri: { type: 'string' } },
              required: ['uri'],
            },
          },
        ]
      : [];
  return {
    tools,
    handles: (name: string) => names.some((value) => value === name),
    async call(name: string, args: Record<string, unknown>, signal?: AbortSignal) {
      signal?.throwIfAborted();
      if (name === names[0])
        return textResult(
          (await content.catalog(access)).map((entry) => ({
            id: entry.id,
            kind: entry.kind,
            ...content.definition(entry),
          })),
        );
      if (name === names[1]) {
        const input = z
          .object({ id: z.string(), arguments: z.record(z.string(), z.string()).optional() })
          .strict()
          .parse(args);
        return textResult(await content.prompt({ ...access, ...input, signal }));
      }
      if (name === names[2]) {
        const input = z.object({ uri: z.string() }).strict().parse(args);
        return textResult(await content.read({ ...access, ...input, signal }));
      }
      throw new Error(`Unknown content tool: ${name}`);
    },
  };
}
