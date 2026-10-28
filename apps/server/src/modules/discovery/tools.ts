import { z } from 'zod';
import type { Tool } from '@platform/mcp';
export const searchInput = z
  .object({ query: z.string().trim().min(1), limit: z.number().int().positive().default(10) })
  .strict();
export const definitionInput = z.object({ toolId: z.string().min(1) }).strict();
export const discoverCallInput = definitionInput.extend({
  arguments: z.record(z.string(), z.unknown()).default({}),
});
const object = (
  properties: NonNullable<Tool['inputSchema']['properties']>,
  required: string[],
) => ({ type: 'object' as const, properties, required, additionalProperties: false });
export const discoveryTools: Tool[] = [
  {
    name: 'platform_tools_search',
    description: '在当前身份已授权的工具目录中执行语义搜索；不会唤醒休眠连接。',
    inputSchema: object(
      {
        query: { type: 'string', minLength: 1 },
        limit: { type: 'integer', minimum: 1, default: 10 },
      },
      ['query'],
    ),
  },
  {
    name: 'platform_tools_definition',
    description: '获取已授权工具的完整生效定义。',
    inputSchema: object({ toolId: { type: 'string' } }, ['toolId']),
  },
  {
    name: 'platform_tools_call',
    description: '使用稳定工具 ID 调用已授权工具；arguments 必须符合生效定义。',
    inputSchema: object({ toolId: { type: 'string' }, arguments: { type: 'object' } }, ['toolId']),
  },
];
