import { z } from 'zod';
import type { Tool } from '@platform/mcp';
import type { ArtifactService } from './artifactService.js';
import type { AccessService, Access } from '../permissions/accessService.js';
import type { ProfileService } from '../agent-profiles/profileService.js';
import { AppError } from '../../shared/errors.js';

const names = ['platform_artifacts_catalog', 'platform_artifacts_read'] as const;
export const isArtifactTool = (name: string) => names.some((value) => value === name);
export async function artifactToolset(
  deps: { artifacts: ArtifactService; access: AccessService; profiles: ProfileService },
  access: Access,
) {
  const effective = await deps.access.effective(access);
  const profile = await deps.profiles.owned(access.ownerId, access.profileId!);
  const tools: Tool[] =
    effective?.artifactIds.length ||
    profile.requestable.artifactIds.length ||
    (await deps.profiles.hasArtifactOutputs(access.ownerId, access.profileId!))
      ? [
          {
            name: names[0],
            description:
              '查看当前 Agent 与调用主体已授权产物的名称、大小和 SHA-256；可申请但未获批的文件不会列出。',
            inputSchema: { type: 'object' as const, properties: {}, additionalProperties: false },
            annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
          },
          {
            name: names[1],
            description:
              '按产物 ID 读取指定字节区间。文本可选 utf8，二进制或跨字符边界的分段使用 base64（默认）；offset 和 length 均以字节计，不接收设备本地路径。',
            inputSchema: {
              type: 'object' as const,
              properties: {
                id: { type: 'string', format: 'uuid' },
                offset: { type: 'integer', minimum: 0 },
                length: { type: 'integer', minimum: 1 },
                encoding: { type: 'string', enum: ['base64', 'utf8'], default: 'base64' },
              },
              required: ['id', 'offset', 'length'],
              additionalProperties: false,
            },
            annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
          },
        ]
      : [];
  return {
    tools,
    handles: isArtifactTool,
    async call(name: string, args: Record<string, unknown>, signal?: AbortSignal) {
      signal?.throwIfAborted();
      const permissions = await deps.access.effective(access);
      if (!isArtifactTool(name)) throw new AppError('UNKNOWN_TOOL', '未知产物工具');
      if (name === names[0]) {
        z.object({}).strict().parse(args);
        return text(
          (await deps.artifacts.listSelected(access.ownerId, permissions!.artifactIds)).map(
            (row) => ({
              ...row,
              downloadPath: `/mcp/${encodeURIComponent(access.profileId!)}/artifacts/${encodeURIComponent(row.id)}`,
              authorizationRequired: true,
            }),
          ),
        );
      }
      const input = z
        .object({
          id: z.uuid(),
          offset: z.number().int().nonnegative(),
          length: z.number().int().positive(),
          encoding: z.enum(['base64', 'utf8']).default('base64'),
        })
        .strict()
        .parse(args);
      await deps.access.assert(access, 'artifactIds', input.id);
      const blob = await deps.artifacts.blob(access.ownerId, input.id);
      const bytes = Buffer.from(
        await blob.slice(input.offset, input.offset + input.length).arrayBuffer(),
      );
      signal?.throwIfAborted();
      await deps.access.assert(access, 'artifactIds', input.id);
      return text({
        id: input.id,
        offset: input.offset,
        length: bytes.length,
        size: blob.size,
        encoding: input.encoding,
        data: encodeBytes(bytes, input.encoding),
      });
    },
  };
}
function encodeBytes(bytes: Uint8Array, encoding: 'base64' | 'utf8') {
  if (encoding === 'base64') return Buffer.from(bytes).toString('base64');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new AppError(
      'INVALID_UTF8',
      '所选字节不是完整的 UTF-8 文本，请调整字节区间或使用 base64',
    );
  }
}
const text = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value) }],
});
