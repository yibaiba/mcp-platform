import type { ConnectionContext } from '../mcp/adapter.js';
import { AppError } from '../../shared/errors.js';

export const credentialScope = (context: ConnectionContext) =>
  context.credentialScope ?? {
    ownerId: context.ownerId,
    connectionId: context.id,
    bindingId: context.bindingId ?? context.id,
    identity: context.identity ?? 'default',
  };
export const credentialKey = (context: ConnectionContext) => {
  const scope = credentialScope(context);
  return `${scope.ownerId}:${scope.bindingId}`;
};
export function assertCredentialManager(context: ConnectionContext) {
  if (credentialScope(context).ownerId !== context.ownerId)
    throw new AppError('SHARE_OWNER_CREDENTIALS', '共享凭证由连接所有者管理', 403);
}
export type CredentialCoordination = {
  writes: Promise<void>;
  authorizing: Promise<unknown>;
  generation: number;
  revoked: boolean;
};
export const credentialCoordination = (): CredentialCoordination => ({
  writes: Promise.resolve(),
  authorizing: Promise.resolve(),
  generation: 0,
  revoked: false,
});
