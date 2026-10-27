import { z } from 'zod';
import type { ArtifactService } from '../artifacts/artifactService.js';
import type { AccessService, Access } from '../permissions/accessService.js';
import type { ProfileService } from '../agent-profiles/profileService.js';

const names = ['platform_artifacts_catalog', 'platform_artifacts_read'] as const;
export async function artifactToolset(
  deps: { artifacts: ArtifactService; access: AccessService; profiles: ProfileService },
  access: Access,
) {
  const effective = await deps.access.effective(access);
  const profile = await deps.profiles.owned(access.ownerId, access.profileId!);
  const tools =
    effective?.artifactIds.length || profile.requestable.artifactIds.length
      ? [
          {
            name: names[0],
            description: '查看当前任务已授权产物的名称、大小和 SHA-256。',
            inputSchema: { type: 'object' as const, properties: {}, additionalProperties: false },
          },
          {
            name: names[1],
            description:
              '按产物 ID 读取明确指定的字节区间，返回 base64；不会把设备本地路径当作文件。',
            inputSchema: {
              type: 'object' as const,
              properties: {
                id: { type: 'string', format: 'uuid' },
                offset: { type: 'integer', minimum: 0 },
                length: { type: 'integer', minimum: 1 },
              },
              required: ['id', 'offset', 'length'],
              additionalProperties: false,
            },
          },
        ]
      : [];
  return {
    tools,
    handles: (name: string) => names.some((value) => value === name),
    async call(name: string, args: Record<string, unknown>, signal?: AbortSignal) {
      signal?.throwIfAborted();
      const permissions = await deps.access.effective(access);
      if (name === names[0])
        return text(
          (await deps.artifacts.list(access.ownerId)).filter((row) =>
            permissions!.artifactIds.includes(row.id),
          ),
        );
      const input = z
        .object({
          id: z.uuid(),
          offset: z.number().int().nonnegative(),
          length: z.number().int().positive(),
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
        encoding: 'base64',
        data: bytes.toString('base64'),
      });
    },
  };
}
const text = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value) }],
});
