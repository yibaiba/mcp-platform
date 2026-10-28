import { and, eq } from 'drizzle-orm';
import { profiles, type Database } from '@platform/db';
import { connectionInput, type ConnectionInput } from '@platform/contracts';
import { digest, type Vault } from '../../shared/crypto.js';
import { AppError } from '../../shared/errors.js';
import type { BindingService } from '../authorizations/bindingService.js';
import type { ShareService } from '../shares/shareService.js';
import { currentExecution, sessionScope, PLATFORM_CAPABILITIES } from './executionContext.js';
import type { ConnectionContext } from './adapter.js';

export async function connectionContext(
  deps: { db: Database; vault: Vault; bindings: BindingService; shares: ShareService },
  input: { ownerId: string; id: string },
): Promise<ConnectionContext> {
  const { ownerId, id } = input;
  const { connection: row, share } = await deps.shares.connection(ownerId, id);
  const source = connectionInput.parse(
    deps.vault.open<ConnectionInput>(row.config, `${row.ownerId}:${id}`),
  );
  const config =
    share?.credentialMode === 'independent' ? deps.shares.config(ownerId, share) : source;
  const caller = currentExecution();
  const [profile] = caller?.profileId
    ? await deps.db
        .select()
        .from(profiles)
        .where(and(eq(profiles.id, caller.profileId), eq(profiles.ownerId, ownerId)))
    : [];
  if (caller?.profileId && !profile)
    throw new AppError('ACCESS_CONTEXT', 'Agent 不属于当前账号', 403);
  const scope = sessionScope(config, profile?.connectionIdentities[id]);
  const prefix = share ? `share:${share.id}:` : '';
  const identity =
    prefix && !scope.identity.startsWith(prefix) ? `${prefix}${scope.identity}` : scope.identity;
  const binding = await deps.bindings.resolve({ ownerId, connectionId: id, identity });
  const delegated = share?.credentialMode === 'owner';
  const credentialBinding = delegated
    ? await deps.bindings.resolve({
        ownerId: row.ownerId,
        connectionId: id,
        identity: source.identityMode === 'independent' ? 'dashboard' : 'default',
      })
    : binding;
  const scopedConfig = await deps.bindings.configuration(
    credentialBinding,
    config,
    !delegated &&
      (profile?.connectionIdentities[id] === 'profile' ||
        profile?.connectionIdentities[id] === 'credential'),
  );
  const capabilityKey = share
    ? `${scope.capabilityKey}:share-${share.version}`
    : scope.capabilityKey;
  return {
    id,
    revision: row.revision,
    ownerId,
    resourceOwnerId: row.ownerId,
    shareId: share?.id,
    shareVersion: share?.version,
    credentialScope: {
      ownerId: credentialBinding.ownerId,
      connectionId: id,
      bindingId: credentialBinding.id,
      identity: credentialBinding.identity,
    },
    bindingId: binding.id,
    identity,
    sessionId: scope.session,
    capabilityKey,
    runtimeKey: `${id}:${binding.id}:${scope.capabilityKey}:${digest(scope.session)}:${scope.headerKey}${share ? `:share-${share.version}` : ''}`,
    capabilities: caller?.capabilities ?? PLATFORM_CAPABILITIES,
    correlationId: caller?.correlationId,
    profileId: caller?.profileId,
    config: { ...scopedConfig, headers: { ...scopedConfig.headers, ...scope.headers } },
  };
}
