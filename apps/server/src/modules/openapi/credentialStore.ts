import { and, eq } from 'drizzle-orm';
import { authorizationBindings, type Database } from '@platform/db';
import type { Vault } from '../../shared/crypto.js';
import type { ConnectionContext } from '../mcp/adapter.js';
import { credentialScope } from '../authorizations/credentialScope.js';
import { AppError } from '../../shared/errors.js';
export type ApiToken = {
  access_token: string;
  refresh_token?: string;
  scope?: string;
  expiresAt?: number;
};
export type ApiAuthState = {
  tokens?: ApiToken;
  state?: string;
  flowId?: string;
  verifier?: string;
  expiresAt?: number;
  metadata?: Record<string, unknown>;
};
export class ApiCredentialStore {
  private readonly queues = new Map<string, Promise<unknown>>();
  constructor(private readonly deps: { db: Database; vault: Vault }) {}
  async read(context: ConnectionContext): Promise<Record<string, ApiAuthState>> {
    const [row] = await this.deps.db
      .select()
      .from(authorizationBindings)
      .where(
        and(
          eq(authorizationBindings.id, credentialScope(context).bindingId!),
          eq(authorizationBindings.ownerId, credentialScope(context).ownerId),
          eq(authorizationBindings.revoked, false),
        ),
      );
    if (!row) throw new AppError('BINDING_REVOKED', '授权绑定不存在或已撤销', 403);
    return row.encrypted
      ? this.deps.vault.open(
          row.encrypted,
          `openapi:${credentialScope(context).ownerId}:${credentialScope(context).bindingId}`,
        )
      : {};
  }
  async change<T>(
    context: ConnectionContext,
    action: (
      state: Record<string, ApiAuthState>,
    ) => Promise<{ state: Record<string, ApiAuthState>; result: T }>,
  ) {
    const key = credentialScope(context).bindingId!;
    const previous = this.queues.get(key) ?? Promise.resolve();
    const pending = previous.then(async () => {
      const next = await action(await this.read(context));
      const rows = await this.deps.db
        .update(authorizationBindings)
        .set({
          encrypted: this.deps.vault.seal(
            next.state,
            `openapi:${credentialScope(context).ownerId}:${key}`,
          ),
        })
        .where(and(eq(authorizationBindings.id, key), eq(authorizationBindings.revoked, false)))
        .returning({ id: authorizationBindings.id });
      if (!rows.length) throw new AppError('BINDING_REVOKED', '授权已撤销', 403);
      return next.result;
    });
    this.queues.set(
      key,
      pending.then(
        () => undefined,
        () => undefined,
      ),
    );
    return pending;
  }
}
