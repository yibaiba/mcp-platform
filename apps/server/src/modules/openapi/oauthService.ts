import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { httpUrl } from '@platform/contracts';
import type { ConnectionContext } from '../mcp/adapter.js';
import type { SecurityScheme } from './types.js';
import { ApiCredentialStore, type ApiAuthState, type ApiToken } from './credentialStore.js';
import { AppError } from '../../shared/errors.js';
const tokenSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string().refine((v) => v.toLowerCase() === 'bearer'),
  refresh_token: z.string().optional(),
  scope: z.string().optional(),
  expires_in: z.number().positive().optional(),
});
export class ApiOAuthService {
  constructor(
    private readonly deps: { store: ApiCredentialStore; fetch: typeof fetch; publicUrl: string },
  ) {}
  private credential(context: ConnectionContext, name: string) {
    const credential = context.config.openapi?.credentials[name];
    if (!credential?.clientId)
      throw new AppError('OPENAPI_CLIENT_REQUIRED', `OAuth ${name} 需要预注册 clientId`);
    return credential;
  }
  private scheme(context: ConnectionContext, name: string) {
    const components = context.config.openapi!.document.components as
      | { securitySchemes?: Record<string, SecurityScheme> }
      | undefined;
    const scheme = components?.securitySchemes?.[name];
    if (!scheme || !['oauth2', 'openIdConnect'].includes(scheme.type))
      throw new AppError('OPENAPI_OAUTH', 'OAuth 方案不存在');
    return scheme;
  }
  private async metadata(context: ConnectionContext, name: string) {
    const scheme = this.scheme(context, name);
    if (scheme.type === 'openIdConnect') {
      const response = await this.deps.fetch(httpUrl.parse(scheme.openIdConnectUrl), {
        redirect: 'error',
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok)
        throw new AppError('OIDC_DISCOVERY', `OIDC 发现失败：HTTP ${response.status}`, 502);
      const value = z
        .object({ issuer: httpUrl, authorization_endpoint: httpUrl, token_endpoint: httpUrl })
        .passthrough()
        .parse(await response.json());
      const issuer = new URL(value.issuer);
      const discovery = new URL(scheme.openIdConnectUrl!);
      if (
        issuer.origin !== discovery.origin ||
        !discovery.pathname.startsWith(issuer.pathname.replace(/\/$/, '') + '/.well-known/')
      )
        throw new AppError('OIDC_ISSUER', 'OIDC issuer 与发现地址不匹配');
      return value;
    }
    const flow = (scheme.flows?.authorizationCode ?? scheme.flows?.clientCredentials) as
      | { authorizationUrl?: string; tokenUrl?: string }
      | undefined;
    if (!flow?.tokenUrl) throw new AppError('OPENAPI_OAUTH_FLOW', '仅支持授权码或客户端凭证流程');
    return {
      issuer: flow.tokenUrl,
      authorization_endpoint: flow.authorizationUrl,
      token_endpoint: httpUrl.parse(flow.tokenUrl),
    };
  }
  redirect(context: ConnectionContext, name: string) {
    const binding = context.identity !== 'default' ? `/bindings/${context.bindingId}` : '';
    return `${this.deps.publicUrl}/api/v1/connections/${context.id}${binding}/openapi/oauth/${encodeURIComponent(name)}/callback`;
  }
  async status(context: ConnectionContext, name: string) {
    const stored = (await this.deps.store.read(context))[name];
    return {
      authorized: Boolean(stored?.tokens),
      scope: stored?.tokens?.scope,
      pending: Boolean(stored?.state && stored.expiresAt && stored.expiresAt > Date.now()),
    };
  }
  revoke(context: ConnectionContext, name: string) {
    return this.deps.store.change(context, async (stored) => ({
      state: Object.fromEntries(Object.entries(stored).filter(([key]) => key !== name)),
      result: { authorized: false },
    }));
  }
  async start(context: ConnectionContext, name: string) {
    const metadata = await this.metadata(context, name);
    const credential = this.credential(context, name);
    if (!metadata.authorization_endpoint)
      throw new AppError('OPENAPI_OAUTH_FLOW', '此方案使用客户端凭证，无交互授权');
    const state = randomBytes(32).toString('base64url');
    const verifier = randomBytes(32).toString('base64url');
    await this.deps.store.change(context, async (stored) => ({
      state: {
        ...stored,
        [name]: {
          ...stored[name],
          metadata,
          state,
          flowId: state,
          verifier,
          expiresAt: Date.now() + 600_000,
        },
      },
      result: undefined,
    }));
    const url = new URL(metadata.authorization_endpoint);
    for (const [key, value] of Object.entries({
      client_id: credential.clientId!,
      response_type: 'code',
      redirect_uri: this.redirect(context, name),
      state,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
      scope: credential.scopes.join(' '),
    }))
      url.searchParams.set(key, value);
    return { authorizationUrl: url.toString(), redirectUrl: this.redirect(context, name) };
  }
  async complete(
    context: ConnectionContext,
    name: string,
    input: { code: string; state: string; issuer?: string },
  ) {
    const pending = await this.deps.store.change(context, async (stored) => {
      const pending = stored[name];
      if (
        !pending?.state ||
        pending.state !== input.state ||
        !pending.expiresAt ||
        pending.expiresAt < Date.now()
      )
        throw new AppError('OAUTH_STATE', '授权状态无效或已过期');
      return {
        state: { ...stored, [name]: { ...pending, state: undefined, verifier: undefined } },
        result: pending,
      };
    });
    if (input.issuer && pending.metadata?.issuer !== input.issuer)
      throw new AppError('OIDC_ISSUER', '回调 issuer 不匹配');
    const tokens = await this.exchange(context, name, pending, {
      grant_type: 'authorization_code',
      code: input.code,
      code_verifier: pending.verifier!,
      redirect_uri: this.redirect(context, name),
    });
    await this.deps.store.change(context, async (stored) => {
      if (stored[name]?.flowId !== input.state)
        throw new AppError('OAUTH_REVOKED', '授权流程已撤销或被替换，拒绝迟到的凭证', 409);
      return {
        state: { ...stored, [name]: { metadata: pending.metadata, tokens } },
        result: undefined,
      };
    });
    return { authorized: true };
  }
  async token(context: ConnectionContext, name: string, scopes: string[]) {
    return this.deps.store.change(context, async (stored) => {
      let current = stored[name];
      const metadata = await this.metadata(context, name);
      if (current?.metadata?.issuer && current.metadata.issuer !== metadata.issuer)
        throw new AppError('OIDC_ISSUER', 'OAuth issuer 已改变，请重新授权', 401);
      current ??= { metadata };
      let tokens = current.tokens;
      if (!tokens || (tokens.expiresAt && tokens.expiresAt <= Date.now())) {
        const scheme = this.scheme(context, name);
        if (tokens?.refresh_token) {
          const refreshed = await this.exchange(context, name, current, {
            grant_type: 'refresh_token',
            refresh_token: tokens.refresh_token,
          });
          tokens = { ...refreshed, refresh_token: refreshed.refresh_token ?? tokens.refresh_token };
        } else if (scheme.flows?.clientCredentials)
          tokens = await this.exchange(context, name, current, {
            grant_type: 'client_credentials',
            scope: this.credential(context, name).scopes.join(' '),
          });
        else throw new AppError('OPENAPI_AUTH_REQUIRED', `OAuth ${name} 需要先完成授权`, 401);
      }
      const granted = tokens.scope?.split(' ') ?? this.credential(context, name).scopes;
      if (scopes.some((scope) => !granted.includes(scope)))
        throw new AppError('OAUTH_SCOPE', 'OAuth scope 不足', 403);
      return { state: { ...stored, [name]: { metadata, tokens } }, result: tokens.access_token };
    });
  }
  private async exchange(
    context: ConnectionContext,
    name: string,
    current: ApiAuthState,
    params: Record<string, string>,
  ): Promise<ApiToken> {
    const credential = this.credential(context, name);
    const body = new URLSearchParams({ ...params, client_id: credential.clientId! });
    const method =
      credential.tokenEndpointAuthMethod ??
      (credential.clientSecret ? 'client_secret_post' : 'none');
    const headers = new Headers({ 'Content-Type': 'application/x-www-form-urlencoded' });
    if (method !== 'none' && !credential.clientSecret)
      throw new AppError('OAUTH_CLIENT_SECRET', '所选认证方式需要 clientSecret');
    if (method === 'client_secret_post') body.set('client_secret', credential.clientSecret!);
    if (method === 'client_secret_basic')
      headers.set(
        'Authorization',
        `Basic ${Buffer.from(`${encodeURIComponent(credential.clientId!)}:${encodeURIComponent(credential.clientSecret!)}`).toString('base64')}`,
      );
    const response = await this.deps.fetch(httpUrl.parse(current.metadata?.token_endpoint), {
      method: 'POST',
      headers,
      body,
      redirect: 'error',
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok)
      throw new AppError('OAUTH_TOKEN', `OAuth 交换或刷新失败：HTTP ${response.status}`, 401);
    const token = tokenSchema.parse(await response.json());
    return {
      ...token,
      expiresAt: token.expires_in ? Date.now() + token.expires_in * 1000 : undefined,
    };
  }
}
