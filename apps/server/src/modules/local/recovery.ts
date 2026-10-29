import { localBindingMutation, type LocalState } from '@platform/contracts';
import type { LocalRepository } from './repository.js';
import type { LocalBindingService } from './bindingService.js';
import { AppError, errorMessage } from '../../shared/errors.js';
export class LocalRecovery {
  constructor(
    private readonly deps: { repository: LocalRepository; bindings: LocalBindingService },
  ) {}
  async mutations(ownerId: string, deviceId: string) {
    for (const op of await this.deps.repository.operations(ownerId, deviceId)) {
      if (
        !['pending', 'running'].includes(op.phase) ||
        !['update', 'resolve', 'delete', 'unlink'].includes(op.action)
      )
        continue;
      try {
        const input = localBindingMutation.parse(op.input);
        const row = await this.deps.repository.owned(ownerId, { deviceId, id: input.id });
        this.deps.bindings.validate(row, input.content);
        if (row.revision !== input.revision)
          throw new AppError('REVISION_CONFLICT', '恢复操作时同步副本已改变，请重新比较差异', 409);
        await this.deps.bindings.mutate(row, input, op.id);
      } catch (error) {
        await this.deps.repository.finish(op.id, { phase: 'failed', error: errorMessage(error) });
      }
    }
  }
  async completed(ownerId: string, deviceId: string, state: LocalState) {
    for (const op of await this.deps.repository.operations(ownerId, deviceId)) {
      if (!['pending', 'running'].includes(op.phase)) continue;
      if (op.action === 'reconcile')
        await this.deps.repository.finish(op.id, {
          phase: 'succeeded',
          result: { reconciled: true },
        });
      if (op.action !== 'sync.apply') continue;
      const local = state.operations[String(op.input.operationId)];
      if (local && !['running', 'prepared'].includes(local.phase))
        await this.deps.repository.finish(op.id, {
          phase: local.phase,
          result: local,
          error: local.error,
        });
    }
  }
}
