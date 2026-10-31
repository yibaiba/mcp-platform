import { activeUser } from '../users/userAccess.js';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { and, eq, gt } from 'drizzle-orm';
import { oauthClients, oauthCodes, oauthGrants, type Database } from '@platform/db';
import { digest, secretToken } from '../../shared/crypto.js';
import { AppError, requireValue } from '../../shared/errors.js';
import type { ProfileService } from '../agent-profiles/profileService.js';
const TOKEN_LIFETIME = 3600;
const REFRESH_LIFETIME = 30 * 24 * 3600_000;
// Schemes a browser or OS handles itself: never valid as a native app's private-use callback.
const reservedSchemes = new Set([
  'about:',
  'blob:',
  'chrome:',
  'data:',
  'file:',
  'filesystem:',
  'ftp:',
  'javascript:',
  'mailto:',
  'sms:',
  'tel:',
  'view-source:',
  'vbscript:',
  'ws:',
  'wss:',
]);
/**
 * HTTPS, HTTP loopback, or a native app's private-use scheme (RFC 8252 §7.1). Cursor registers
 * `cursor://anysphere.cursor-mcp/oauth/callback` alongside its loopback callback in one DCR call,
 * so rejecting the custom scheme would fail its whole registration.
 */
const redirectSchema = z.string().refine((raw) => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.hash || url.username || url.password) return false;
  if (url.protocol === 'https:') return true;
  if (url.protocol === 'http:') return ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  return /^[a-z][a-z0-9+.-]*:$/.test(url.protocol) && !reservedSchemes.has(url.protocol);
}, 'Redirect must use HTTPS, HTTP loopback or a private-use app scheme');
export const authorizeSchema = z.object({
  client_id: z.uuid(),
  redirect_uri: redirectSchema,
  response_type: z.literal('code'),
  code_challenge_method: z.literal('S256'),
  code_challenge: z.string().regex(/^[\w-]{43}$/),
  resource: z.url(),
  state: z.string().min(1),
  scope: z.string().optional(),
});
export class AgentOAuth {
  constructor(
    private readonly deps: { db: Database; profiles: ProfileService; publicUrl: string },
  ) {}
  metadata() {
    const base = this.deps.publicUrl;
    return {
      issuer: base,
      authorization_endpoint: `${base}/api/v1/oauth/authorize`,
      token_endpoint: `${base}/api/v1/oauth/token`,
      registration_endpoint: `${base}/api/v1/oauth/register`,
      revocation_endpoint: `${base}/api/v1/oauth/revoke`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: ['mcp'],
    };
  }
  async register(input: unknown) {
    const value = z
      .object({
        client_name: z.string().min(1),
        redirect_uris: z.array(redirectSchema).min(1),
        token_endpoint_auth_method: z.literal('none').optional(),
      })
      .passthrough()
      .parse(input);
    const [row] = await this.deps.db
      .insert(oauthClients)
      .values({ name: value.client_name, redirects: value.redirect_uris })
      .returning();
    return {
      client_id: requireValue(row).id,
      client_name: value.client_name,
      redirect_uris: value.redirect_uris,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    };
  }
  async validate(input: unknown) {
    const value = authorizeSchema.parse(input);
    const [client] = await this.deps.db
      .select()
      .from(oauthClients)
      .where(eq(oauthClients.id, value.client_id));
    if (!client || !client.redirects.includes(value.redirect_uri))
      throw new AppError('invalid_request', '客户端或回调地址不匹配');
    const prefix = `${this.deps.publicUrl}/mcp/`;
    if (!value.resource.startsWith(prefix))
      throw new AppError('invalid_target', '无效 MCP 资源地址');
    const profileId = z.uuid().parse(value.resource.slice(prefix.length));
    if (value.scope && value.scope !== 'mcp')
      throw new AppError('invalid_scope', '仅支持 mcp scope');
    return { value, profileId, clientName: client.name };
  }
  async consent(ownerId: string, input: unknown) {
    const { value, profileId } = await this.validate(input);
    await this.deps.profiles.owned(ownerId, profileId);
    const code = secretToken();
    await this.deps.db.insert(oauthCodes).values({
      hash: digest(code),
      ownerId,
      clientId: value.client_id,
      profileId,
      redirect: value.redirect_uri,
      challenge: value.code_challenge,
      resource: value.resource,
      expiresAt: new Date(Date.now() + 5 * 60_000),
    });
    const redirect = new URL(value.redirect_uri);
    redirect.searchParams.set('code', code);
    redirect.searchParams.set('state', value.state);
    return { redirect: redirect.toString() };
  }
  async token(input: Record<string, string>) {
    if (input.grant_type === 'refresh_token') return this.refresh(input);
    const value = z
      .object({
        grant_type: z.literal('authorization_code'),
        code: z.string(),
        client_id: z.uuid(),
        redirect_uri: redirectSchema,
        code_verifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/),
        resource: z.url(),
      })
      .parse(input);
    return this.deps.db.transaction(async (tx) => {
      const [code] = await tx
        .delete(oauthCodes)
        .where(
          and(
            eq(oauthCodes.hash, digest(value.code)),
            eq(oauthCodes.clientId, value.client_id),
            gt(oauthCodes.expiresAt, new Date()),
          ),
        )
        .returning();
      if (
        !code ||
        code.redirect !== value.redirect_uri ||
        code.resource !== value.resource ||
        code.challenge !== createHash('sha256').update(value.code_verifier).digest('base64url')
      )
        throw new AppError('invalid_grant', '授权码、PKCE 或资源校验失败');
      const tokens = this.newTokens();
      await activeUser(tx, code.ownerId);
      await tx.insert(oauthGrants).values({
        ownerId: code.ownerId,
        clientId: code.clientId,
        profileId: code.profileId,
        ...tokens.stored,
      });
      return tokens.response;
    });
  }
  private newTokens() {
    const access = secretToken();
    const refresh = secretToken();
    return {
      stored: {
        accessHash: digest(access),
        refreshHash: digest(refresh),
        expiresAt: new Date(Date.now() + TOKEN_LIFETIME * 1000),
        refreshExpiresAt: new Date(Date.now() + REFRESH_LIFETIME),
      },
      response: {
        access_token: access,
        refresh_token: refresh,
        token_type: 'Bearer',
        expires_in: TOKEN_LIFETIME,
        scope: 'mcp',
      },
    };
  }
  private async refresh(input: Record<string, string>) {
    const value = z
      .object({ client_id: z.uuid(), refresh_token: z.string(), resource: z.url() })
      .parse(input);
    const tokens = this.newTokens();
    const prefix = `${this.deps.publicUrl}/mcp/`;
    const profileId = z
      .uuid()
      .parse(value.resource.startsWith(prefix) ? value.resource.slice(prefix.length) : '');
    await this.deps.db.transaction(async (tx) => {
      const condition = and(
        eq(oauthGrants.clientId, value.client_id),
        eq(oauthGrants.profileId, profileId),
        eq(oauthGrants.refreshHash, digest(value.refresh_token)),
        eq(oauthGrants.revoked, false),
        gt(oauthGrants.refreshExpiresAt, new Date()),
      );
      const [existing] = await tx.select().from(oauthGrants).where(condition);
      if (!existing) throw new AppError('invalid_grant', '刷新凭证已过期、已使用或已撤销');
      await activeUser(tx, existing.ownerId);
      const [grant] = await tx.update(oauthGrants).set(tokens.stored).where(condition).returning();
      if (!grant) throw new AppError('invalid_grant', '刷新凭证已过期、已使用或已撤销');
    });
    return tokens.response;
  }
  async revoke(token: string) {
    const hash = digest(token);
    const rows = await this.deps.db
      .update(oauthGrants)
      .set({ revoked: true })
      .where(eq(oauthGrants.refreshHash, hash))
      .returning({ id: oauthGrants.id });
    const accessRows = await this.deps.db
      .update(oauthGrants)
      .set({ revoked: true })
      .where(eq(oauthGrants.accessHash, hash))
      .returning({ id: oauthGrants.id });
    return [...rows, ...accessRows].map((row) => row.id);
  }
}
