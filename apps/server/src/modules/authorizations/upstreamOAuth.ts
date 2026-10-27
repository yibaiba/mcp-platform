import type { Database } from '@platform/db';
import { auth } from '@modelcontextprotocol/client';
import type { Vault } from '../../shared/crypto.js';
import { AppError } from '../../shared/errors.js';
import type { ConnectionContext } from '../mcp/adapter.js';
import { PersistedProvider } from './persistedProvider.js';
export class UpstreamOAuth {
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
    let provider = this.providers.get(`${context.ownerId}:${context.bindingId ?? context.id}`);
    if (!provider) {
      provider = new PersistedProvider(this.options, context);
      this.providers.set(`${context.ownerId}:${context.bindingId ?? context.id}`, provider);
    }
    provider.configure(context);
    return provider;
  }
  fetchFor(context: ConnectionContext) {
    return this.options.fetchFor?.(context) ?? this.options.fetch;
  }
  async headers(context: ConnectionContext): Promise<Record<string, string>> {
    const key = `${context.ownerId}:${context.bindingId ?? context.id}`;
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
    const provider = this.provider(context);
    const result = await auth(provider, {
      serverUrl: context.config.url!,
      scope: context.config.oauth?.scope,
      fetchFn: this.options.fetchFor?.(context) ?? this.options.fetch,
    });
    return { status: result, authorizationUrl: (await provider.read()).url };
  }
  async complete(
    context: ConnectionContext,
    input: { code: string; state: string; issuer?: string },
  ) {
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
    const data = await this.provider(context).read();
    return {
      connectionId: context.id,
      authorized: Boolean(data.tokens),
      pending: Boolean(data.state && data.expiresAt && data.expiresAt > Date.now()),
      scope: data.tokens?.scope,
      authorizationUrl: data.url,
    };
  }
  async revoke(context: ConnectionContext) {
    const provider = this.provider(context);
    await provider.revoke();
    this.providers.delete(`${context.ownerId}:${context.bindingId ?? context.id}`);
    return {
      status: 'removed',
      upstreamRevocation: '请在供应商账户中撤销已授予的权限；平台已删除本地凭证',
    };
  }
}
