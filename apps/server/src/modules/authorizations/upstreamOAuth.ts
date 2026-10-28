import type { Database } from '@platform/db';
import { auth } from '@modelcontextprotocol/client';
import type { Vault } from '../../shared/crypto.js';
import { AppError } from '../../shared/errors.js';
import type { ConnectionContext } from '../mcp/adapter.js';
import {
  credentialKey,
  credentialCoordination,
  assertCredentialManager,
  type CredentialCoordination,
} from './credentialScope.js';
import { PersistedProvider } from './persistedProvider.js';
export class UpstreamOAuth {
  private readonly coordination = new Map<string, CredentialCoordination>();
  private readonly providers = new Map<string, PersistedProvider>();
  private readonly refreshing = new Map<string, Promise<Record<string, string>>>();
  constructor(
    private readonly options: {
      db: Database;
      vault: Vault;
      publicUrl: string;
      fetch: typeof fetch;
      fetchFor?: (context: ConnectionContext) => typeof fetch;
    },
  ) {}
  provider(context: ConnectionContext) {
    const scope = credentialKey(context);
    const key = `${scope}:${context.shareId ?? 'owner'}`;
    let provider = this.providers.get(key);
    if (!provider) {
      let state = this.coordination.get(scope);
      if (!state) {
        state = credentialCoordination();
        this.coordination.set(scope, state);
      }
      provider = new PersistedProvider(this.options, context, state);
      this.providers.set(key, provider);
    }
    provider.configure(context);
    return provider;
  }
  fetchFor(context: ConnectionContext) {
    return this.options.fetchFor?.(context) ?? this.options.fetch;
  }
  async headers(context: ConnectionContext): Promise<Record<string, string>> {
    const key = credentialKey(context);
    const pending = this.refreshing.get(key);
    if (pending) return pending;
    const refreshing = this.authorizedHeaders(context);
    this.refreshing.set(key, refreshing);
    try {
      return await refreshing;
    } finally {
      if (this.refreshing.get(key) === refreshing) this.refreshing.delete(key);
    }
  }
  private async authorizedHeaders(context: ConnectionContext): Promise<Record<string, string>> {
    const provider = this.provider(context);
    const stored = await provider.read();
    if (!stored.tokens) return {};
    if (stored.tokenExpiresAt !== undefined && stored.tokenExpiresAt <= Date.now()) {
      const result = await auth(provider, {
        serverUrl: context.config.url!,
        fetchFn: this.fetchFor(context),
      });
      if (result !== 'AUTHORIZED')
        throw new AppError('OAUTH_REQUIRED', '上游授权过期，请重新授权', 401);
    }
    const tokens = await provider.tokens();
    return tokens ? { Authorization: `Bearer ${tokens.access_token}` } : {};
  }
  async start(context: ConnectionContext) {
    assertCredentialManager(context);
    const provider = this.provider(context);
    const result = await auth(provider, {
      serverUrl: context.config.url!,
      scope: context.config.oauth?.scope,
      fetchFn: this.options.fetchFor?.(context) ?? this.options.fetch,
    });
    return {
      status: result,
      authorizationUrl: (await provider.read()).url,
      redirectUrl: provider.redirectUrl,
    };
  }
  async complete(
    context: ConnectionContext,
    input: { code: string; state: string; issuer?: string },
  ) {
    assertCredentialManager(context);
    const provider = this.provider(context);
    const stored = await provider.read();
    if (
      !stored.state ||
      stored.state !== input.state ||
      !stored.expiresAt ||
      stored.expiresAt < Date.now()
    )
      throw new AppError('OAUTH_STATE', '授权状态无效或已过期');
    // Consume state before exchange; a failed exchange requires a fresh explicit flow.
    await provider.update({ state: undefined, expiresAt: undefined, url: undefined });
    await auth(provider, {
      serverUrl: context.config.url!,
      authorizationCode: input.code,
      iss: input.issuer,
      fetchFn: this.options.fetchFor?.(context) ?? this.options.fetch,
    });
  }
  async status(context: ConnectionContext) {
    assertCredentialManager(context);
    const data = await this.provider(context).read();
    return {
      connectionId: context.id,
      authorized: Boolean(data.tokens),
      pending: Boolean(data.state && data.expiresAt && data.expiresAt > Date.now()),
      scope: data.tokens?.scope,
      authorizationUrl: data.url,
      redirectUrl: this.provider(context).redirectUrl,
    };
  }
  async revoke(context: ConnectionContext) {
    assertCredentialManager(context);
    const provider = this.provider(context);
    await provider.revoke();
    const scope = credentialKey(context);
    for (const key of this.providers.keys())
      if (key.startsWith(`${scope}:`)) this.providers.delete(key);
    this.coordination.delete(scope);
    return {
      status: 'removed',
      upstreamRevocation: '请在供应商账户中撤销已授予的权限；平台已删除本地凭证',
    };
  }
}
