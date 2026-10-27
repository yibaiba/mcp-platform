import { and, eq } from 'drizzle-orm';
import { authorizations, authorizationBindings, type Database } from '@platform/db';
import type {
  OAuthClientProvider,
  OAuthDiscoveryState,
  StoredOAuthClientInformation,
  StoredOAuthTokens,
  OAuthClientInformationContext,
} from '@modelcontextprotocol/client';
import { secretToken, type Vault } from '../../shared/crypto.js';
import { AppError } from '../../shared/errors.js';
import type { ConnectionContext } from '../mcp/adapter.js';
interface Credentials {
  client?: StoredOAuthClientInformation;
  tokens?: StoredOAuthTokens;
  verifier?: string;
  state?: string;
  expiresAt?: number;
  url?: string;
  discovery?: OAuthDiscoveryState;
  tokenExpiresAt?: number;
}
export class PersistedProvider implements OAuthClientProvider {
  private writes: Promise<void> = Promise.resolve();
  private authorizing: Promise<unknown> = Promise.resolve();
  private tokenGeneration = 0;
  private revoked = false;
  constructor(
    private readonly options: { db: Database; vault: Vault; publicUrl: string },
    private context: ConnectionContext,
  ) {}
  configure(context: ConnectionContext) {
    this.context = context;
  }
  platformAuthorize(
    action: () => Promise<'AUTHORIZED' | 'REDIRECT'>,
    options: { authorizationCode?: string; forceReauthorization?: boolean },
  ) {
    const generation = this.tokenGeneration;
    const pending = this.authorizing.then(async () => {
      if (this.revoked) throw new AppError('OAUTH_REVOKED', '授权已撤销', 401);
      if (
        !options.authorizationCode &&
        !options.forceReauthorization &&
        generation !== this.tokenGeneration &&
        (await this.tokens())
      )
        return 'AUTHORIZED' as const;
      return action();
    });
    this.authorizing = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }
  get redirectUrl() {
    if (this.context.identity && this.context.identity !== 'default')
      return `${this.options.publicUrl}/api/v1/connections/${this.context.id}/bindings/${this.context.bindingId}/oauth/callback`;
    return `${this.options.publicUrl}/api/v1/connections/${this.context.id}/oauth/callback`;
  }
  get clientMetadataUrl() {
    return this.context.config.oauth?.clientMetadataUrl;
  }
  get addClientAuthentication(): OAuthClientProvider['addClientAuthentication'] {
    const method = this.context.config.oauth?.tokenEndpointAuthMethod;
    if (!method) return undefined;
    return async (headers, params, _url, metadata) => {
      const supported = metadata?.token_endpoint_auth_methods_supported;
      if (supported?.length && !supported.includes(method))
        throw new AppError('OAUTH_AUTH_METHOD', '授权服务器不支持已配置的客户端认证方式', 401);
      const client = await this.clientInformation();
      if (!client) throw new AppError('OAUTH_CLIENT', '缺少 OAuth 客户端信息', 401);
      params.set('client_id', client.client_id);
      if (method === 'none') return;
      if (!client.client_secret)
        throw new AppError('OAUTH_CLIENT_SECRET', '客户端认证方式需要 clientSecret', 401);
      if (method === 'client_secret_post') params.set('client_secret', client.client_secret);
      else
        headers.set(
          'Authorization',
          `Basic ${Buffer.from(`${encodeURIComponent(client.client_id)}:${encodeURIComponent(client.client_secret)}`).toString('base64')}`,
        );
    };
  }
  get clientMetadata() {
    return {
      client_name: 'MCP Platform',
      redirect_uris: [this.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method:
        this.context.config.oauth?.tokenEndpointAuthMethod ??
        (this.context.config.oauth?.clientSecret ? 'client_secret_post' : 'none'),
      scope: this.context.config.oauth?.scope,
    };
  }
  private get independent() {
    return this.context.identity && this.context.identity !== 'default';
  }
  private get encryptionKey() {
    return `oauth:${this.context.ownerId}:${this.independent ? this.context.bindingId : this.context.id}`;
  }
  async read(): Promise<Credentials> {
    if (this.independent) {
      const [row] = await this.options.db
        .select()
        .from(authorizationBindings)
        .where(
          and(
            eq(authorizationBindings.id, this.context.bindingId!),
            eq(authorizationBindings.ownerId, this.context.ownerId),
          ),
        );
      if (!row || row.revoked) throw new AppError('OAUTH_REVOKED', '授权绑定已撤销', 401);
      return row.encrypted
        ? this.options.vault.open<Credentials>(row.encrypted, this.encryptionKey)
        : {};
    }
    const [row] = await this.options.db
      .select()
      .from(authorizations)
      .where(
        and(
          eq(authorizations.connectionId, this.context.id),
          eq(authorizations.ownerId, this.context.ownerId),
        ),
      );
    return row ? this.options.vault.open<Credentials>(row.encrypted, this.encryptionKey) : {};
  }
  update(patch: Partial<Credentials>) {
    const write = this.writes.then(async () => {
      if (this.revoked) throw new AppError('OAUTH_REVOKED', '授权已撤销，请重新发起授权', 401);
      const encrypted = this.options.vault.seal(
        { ...(await this.read()), ...patch },
        this.encryptionKey,
      );
      if (this.independent) {
        const rows = await this.options.db
          .update(authorizationBindings)
          .set({ encrypted })
          .where(
            and(
              eq(authorizationBindings.id, this.context.bindingId!),
              eq(authorizationBindings.revoked, false),
            ),
          )
          .returning({ id: authorizationBindings.id });
        if (!rows.length) throw new AppError('OAUTH_REVOKED', '授权绑定已撤销', 401);
        return;
      }
      await this.options.db
        .insert(authorizations)
        .values({ connectionId: this.context.id, ownerId: this.context.ownerId, encrypted })
        .onConflictDoUpdate({
          target: authorizations.connectionId,
          set: { encrypted, updatedAt: new Date() },
        });
    });
    this.writes = write.catch(() => {}); // Keep the queue usable; the caller still receives the rejection.
    return write;
  }
  async revoke() {
    this.revoked = true;
    await this.writes;
    if (this.independent) {
      await this.options.db
        .update(authorizationBindings)
        .set({ encrypted: null })
        .where(eq(authorizationBindings.id, this.context.bindingId!));
      return;
    }
    await this.options.db
      .delete(authorizations)
      .where(
        and(
          eq(authorizations.connectionId, this.context.id),
          eq(authorizations.ownerId, this.context.ownerId),
        ),
      );
  }
  async state() {
    const state = secretToken();
    await this.update({ state, expiresAt: Date.now() + 10 * 60_000 });
    return state;
  }
  async clientInformation(context?: OAuthClientInformationContext) {
    const config = this.context.config.oauth;
    const stored = (await this.read()).client;
    if (!config?.clientId) return stored;
    const client = {
      client_id: config.clientId,
      client_secret: config.clientSecret,
      token_endpoint_auth_method: config.tokenEndpointAuthMethod,
      issuer: stored?.issuer,
    };
    if (!client.issuer && context) {
      const stamped = { ...client, issuer: context.issuer };
      await this.update({ client: stamped });
      return stamped;
    }
    return client;
  }
  saveClientInformation(
    client: StoredOAuthClientInformation,
    context?: OAuthClientInformationContext,
  ) {
    return this.update({ client: { ...client, issuer: client.issuer ?? context?.issuer } });
  }
  async tokens() {
    return (await this.read()).tokens;
  }
  saveTokens(tokens: StoredOAuthTokens, context?: OAuthClientInformationContext) {
    return this.update({
      tokens: { ...tokens, issuer: tokens.issuer ?? context?.issuer },
      tokenExpiresAt:
        tokens.expires_in !== undefined ? Date.now() + tokens.expires_in * 1000 : undefined,
    }).then(() => {
      this.tokenGeneration++;
    });
  }
  redirectToAuthorization(url: URL) {
    return this.update({ url: url.toString() });
  }
  saveCodeVerifier(verifier: string) {
    return this.update({ verifier });
  }
  async codeVerifier() {
    const value = (await this.read()).verifier;
    if (!value) throw new AppError('PKCE_MISSING', '缺少 PKCE verifier，请重新授权');
    return value;
  }
  saveDiscoveryState(discovery: OAuthDiscoveryState) {
    return this.update({ discovery });
  }
  async discoveryState() {
    return (await this.read()).discovery;
  }
  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery') {
    if (scope === 'all')
      return this.update({
        client: undefined,
        tokens: undefined,
        verifier: undefined,
        state: undefined,
        url: undefined,
        discovery: undefined,
      });
    await this.update({ [scope === 'client' ? 'client' : scope]: undefined });
  }
}
