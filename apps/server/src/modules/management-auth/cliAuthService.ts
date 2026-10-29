import { createHash } from 'node:crypto';
import { and, eq, gt } from 'drizzle-orm';
import { cliAuthorize, cliTokenInput, type ManagementScope } from '@platform/contracts';
import { cliCodes, cliGrants, type Database } from '@platform/db';
import { activeUser } from '../users/userAccess.js';
import { digest, secretToken } from '../../shared/crypto.js';
import { AppError } from '../../shared/errors.js';
const ACCESS_SECONDS = 3600;
const REFRESH_MS = 30 * 24 * 3600_000;
const CODE_MS = 5 * 60_000;
const denied = () =>
  new AppError('CLI_UNAUTHORIZED', 'CLI 授权无效、已过期或已撤销，请重新登录', 401);
export class CliAuthService {
  constructor(private readonly db: Database) {}
  async consent(ownerId: string, input: unknown) {
    const value = cliAuthorize.parse(input);
    await activeUser(this.db, ownerId);
    const code = secretToken();
    await this.db
      .insert(cliCodes)
      .values({
        hash: digest(code),
        ownerId,
        redirectUri: value.redirect_uri,
        challenge: value.code_challenge,
        scopes: value.scope,
        expiresAt: new Date(Date.now() + CODE_MS),
      });
    const redirect = new URL(value.redirect_uri);
    redirect.searchParams.set('code', code);
    redirect.searchParams.set('state', value.state);
    return { redirect: redirect.toString() };
  }
  private tokens() {
    const access_token = secretToken(),
      refresh_token = secretToken();
    return {
      response: { access_token, refresh_token, token_type: 'Bearer', expires_in: ACCESS_SECONDS },
      stored: {
        accessHash: digest(access_token),
        refreshHash: digest(refresh_token),
        expiresAt: new Date(Date.now() + ACCESS_SECONDS * 1000),
      },
    };
  }
  async token(input: unknown) {
    const value = cliTokenInput.parse(input);
    const tokens = this.tokens();
    return this.db.transaction(async (tx) => {
      if (value.grant_type === 'refresh_token') {
        const [grant] = await tx
          .select()
          .from(cliGrants)
          .where(
            and(
              eq(cliGrants.refreshHash, digest(value.refresh_token)),
              eq(cliGrants.revoked, false),
              gt(cliGrants.refreshExpiresAt, new Date()),
            ),
          )
          .for('update');
        if (!grant) throw denied();
        await activeUser(tx, grant.ownerId);
        await tx.update(cliGrants).set(tokens.stored).where(eq(cliGrants.id, grant.id));
        return {
          ...tokens.response,
          grant_id: grant.id,
          scope: grant.scopes.join(' '),
          refresh_expires_at: grant.refreshExpiresAt.toISOString(),
        };
      }
      const [code] = await tx
        .select()
        .from(cliCodes)
        .where(and(eq(cliCodes.hash, digest(value.code)), gt(cliCodes.expiresAt, new Date())))
        .for('update');
      const challenge = createHash('sha256').update(value.code_verifier).digest('base64url');
      if (!code || code.redirectUri !== value.redirect_uri || code.challenge !== challenge)
        throw denied();
      await activeUser(tx, code.ownerId);
      await tx.delete(cliCodes).where(eq(cliCodes.hash, code.hash));
      const refreshExpiresAt = new Date(Date.now() + REFRESH_MS);
      const [grant] = await tx
        .insert(cliGrants)
        .values({ ...tokens.stored, ownerId: code.ownerId, scopes: code.scopes, refreshExpiresAt })
        .returning({ id: cliGrants.id });
      return {
        ...tokens.response,
        grant_id: grant!.id,
        scope: code.scopes.join(' '),
        refresh_expires_at: refreshExpiresAt.toISOString(),
      };
    });
  }
  async authenticate(token: string, required: ManagementScope) {
    const [grant] = await this.db
      .select()
      .from(cliGrants)
      .where(
        and(
          eq(cliGrants.accessHash, digest(token)),
          eq(cliGrants.revoked, false),
          gt(cliGrants.expiresAt, new Date()),
          gt(cliGrants.refreshExpiresAt, new Date()),
        ),
      );
    if (!grant) throw denied();
    const user = await activeUser(this.db, grant.ownerId);
    if (!grant.scopes.includes(required))
      throw new AppError('CLI_SCOPE', `当前 CLI 授权缺少 ${required}`, 403);
    return { grantId: grant.id, user };
  }
  list(ownerId: string) {
    return this.db
      .select({
        id: cliGrants.id,
        scopes: cliGrants.scopes,
        createdAt: cliGrants.createdAt,
        expiresAt: cliGrants.expiresAt,
        refreshExpiresAt: cliGrants.refreshExpiresAt,
        revoked: cliGrants.revoked,
      })
      .from(cliGrants)
      .where(eq(cliGrants.ownerId, ownerId));
  }
  async revoke(ownerId: string, id: string) {
    const rows = await this.db
      .update(cliGrants)
      .set({ revoked: true })
      .where(and(eq(cliGrants.ownerId, ownerId), eq(cliGrants.id, id)))
      .returning({ id: cliGrants.id });
    if (!rows.length) throw new AppError('NOT_FOUND', 'CLI 授权不存在', 404);
  }
  async revokeOwner(ownerId: string) {
    await this.db.transaction(async (tx) => {
      await tx.update(cliGrants).set({ revoked: true }).where(eq(cliGrants.ownerId, ownerId));
      await tx.delete(cliCodes).where(eq(cliCodes.ownerId, ownerId));
    });
  }
}
