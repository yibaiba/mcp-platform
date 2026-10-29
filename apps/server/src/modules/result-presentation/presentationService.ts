import type { CallToolResult } from '@platform/mcp';
import type { ArtifactService } from '../artifacts/artifactService.js';
import type { ProfileService } from '../agent-profiles/profileService.js';
import { currentExecution } from '../mcp/executionContext.js';
import { AppError } from '../../shared/errors.js';
import { excerpt, textBytes } from './excerpt.js';
export class PresentationService {
  constructor(private readonly deps: { artifacts: ArtifactService; profiles: ProfileService }) {}
  async prepare(input: {
    ownerId: string;
    profileId?: string;
    connectionId: string;
    toolId: string;
    callId: string;
    definition: Record<string, unknown>;
  }) {
    const raw = async (result: CallToolResult) => result;
    if (!input.profileId || currentExecution()?.appId) return raw;
    const profile = await this.deps.profiles.owned(input.ownerId, input.profileId);
    const options = profile.resultPresentation;
    const meta = input.definition._meta as { ui?: { resourceUri?: string } } | undefined;
    if (!options.enabled || meta?.ui?.resourceUri) return raw;
    const write = await this.deps.artifacts.originalWriter(input.ownerId, input);
    return async (result: CallToolResult) => {
      if (result.isError || textBytes(result) <= options.thresholdBytes) return result;
      try {
        const body = Buffer.from(JSON.stringify(result), 'utf8');
        const artifact = await write({
          name: `call-${input.callId}-original.json`,
          body: new Blob([body]).stream(),
        });
        const path = `/mcp/${input.profileId}/artifacts/${artifact.id}`;
        const marker = `完整原文产物 ${artifact.id}，${artifact.size} 字节，SHA-256 ${artifact.sha256}；使用 platform_artifacts_read 按字节读取 JSON 或凭原调用身份下载 ${path}`;
        const presentation = excerpt(result, { retainBytes: options.retainBytes, marker });
        return {
          ...presentation.result,
          _meta: {
            ...result._meta,
            'platform/resultExcerpt': {
              artifactId: artifact.id,
              size: artifact.size,
              sha256: artifact.sha256,
              callId: input.callId,
              format: 'application/json',
              downloadPath: path,
              readTool: 'platform_artifacts_read',
              textBytes: textBytes(result),
              retainedTextBytes: presentation.retainedBytes,
            },
          },
        };
      } catch (cause) {
        const failure = new AppError(
          'RESULT_ORIGINAL_SAVE_FAILED',
          `上游可能已完成、原文保存失败；调用 ID ${input.callId}。请检查数据卷、数据库及当前权限；不会重放上游调用`,
          500,
        );
        failure.cause = cause;
        throw failure;
      }
    };
  }
}
