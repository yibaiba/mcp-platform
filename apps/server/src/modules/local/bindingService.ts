import { z } from 'zod';
import { validatePackage } from '../skills/packageService.js';
import type { LocalResource } from '@platform/contracts';
import { AppError } from '../../shared/errors.js';
import { LocalRepository, equal, type Binding } from './repository.js';
import type { LocalSyncService } from './syncService.js';
import type { LocalMaterializer } from './materializer.js';

export class LocalBindingService {
  validate(row: Binding, content: unknown) {
    if (row.metadata.kind === 'skill' && content !== undefined)
      validatePackage({ name: row.metadata.name, files: content, dependencies: [] });
    if (row.metadata.kind === 'mcp' && content !== undefined)
      validateReferences(
        z.record(z.string(), z.unknown()).parse(content),
        row.baseline,
        row.resourceId,
      );
  }
  constructor(
    private readonly deps: {
      repository: LocalRepository;
      sync: LocalSyncService;
      materializer: LocalMaterializer;
    },
  ) {}
  async mutate(
    row: Binding,
    input: {
      action: 'update' | 'resolve' | 'delete' | 'unlink';
      content?: unknown;
      choice?: 'local' | 'platform' | 'merge';
      confirm?: boolean;
    },
    operationId: string,
  ) {
    if (input.action === 'unlink') {
      const state = await this.deps.sync.state(row.deviceId);
      await this.deps.sync.apply(row, state, { action: 'select', selected: false });
      return this.deps.repository.commit(row, {
        operationId,
        patch: { active: false, status: 'unlinked' },
      });
    }
    if (input.action === 'delete') {
      if (!input.confirm)
        return this.deps.repository.commit(row, {
          operationId,
          patch: { deleted: true, status: 'deletion_pending' },
        });
      const state = await this.deps.sync.state(row.deviceId);
      if (!state.resources[row.resourceId]?.deleted)
        await this.deps.sync.apply(row, state, { action: 'delete', confirm: true });
      await this.deps.materializer.invalidate(row);
      return this.deps.repository.commit(row, {
        operationId,
        patch: { deleted: true, status: 'deleted' },
      });
    }
    let baseline = row.baseline;
    let localDigest = row.localDigest;
    let content = z.record(z.string(), z.unknown()).parse(input.content ?? row.content);
    if (input.action === 'resolve') {
      const state = await this.deps.sync.state(row.deviceId);
      const resource = state.resources[row.resourceId];
      if (!resource) throw new AppError('LOCAL_RESOURCE_MISSING', '本机资源不可用', 409);
      baseline = resource.content;
      localDigest = resource.digest;
      content =
        input.choice === 'local'
          ? resource.content!
          : input.choice === 'platform'
            ? row.content!
            : content;
      if (resource.deleted && input.choice === 'local')
        throw new AppError('DELETE_CONFIRMATION', '本机已删除，需确认传播删除', 409);
    }
    if (row.metadata.kind === 'mcp') validateReferences(content, baseline, row.resourceId);
    const updated = await this.deps.repository.commit(row, {
      operationId,
      patch: {
        content,
        baseline,
        localDigest,
        deleted: false,
        status: 'pending',
        error: null,
      },
    });
    return updated;
  }
}
function validateReferences(
  content: LocalResource['content'],
  baseline: LocalResource['content'],
  id: string,
) {
  const walk = (value: unknown, path: string[], original: unknown): void => {
    if (typeof value === 'string') {
      const publicField =
        path.length === 1 && ['type', 'transport', 'description'].includes(path[0]!);
      if (!publicField && (!value.startsWith(`local://${id}/`) || !equal(value, original)))
        throw new AppError('LOCAL_CREDENTIAL_EDIT', '含凭证或运行参数的字段请在本机管理页编辑');
      return;
    }
    if (!value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value))
      walk(
        item,
        [...path, key],
        original && typeof original === 'object'
          ? (original as Record<string, unknown>)[key]
          : undefined,
      );
  };
  walk(content, [], baseline);
}
