import { hasUsers, promoteFirstUser, removeUser, type Database } from '@platform/db';
import * as schema from '@platform/db/schema/auth';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { genericOAuth } from 'better-auth/plugins';
import { APIError } from 'better-auth/api';
import { oidcUserInfo, type ProviderConfig } from './providers.js';
export function createAuth(options: {
  db: Database;
  baseURL: string;
  webOrigin: string;
  secret: string;
  registration: boolean;
  providers?: ProviderConfig;
  fetch?: typeof fetch;
  /**
   * Better Auth's built-in limiter. Set explicitly so it no longer depends on NODE_ENV;
   * `loginPerMinute` caps sign-in and sign-up per client address and path.
   */
  rateLimit?: { enabled: boolean; loginPerMinute: number };
}) {
  return betterAuth({
    database: drizzleAdapter(options.db, { provider: 'pg', schema }),
    baseURL: options.baseURL,
    basePath: '/api/v1/auth',
    secret: options.secret,
    trustedOrigins: [options.webOrigin],
    // Sign-up stays reachable so the first account of an empty deployment can always be created;
    // the user-create hooks below enforce ALLOW_REGISTRATION for every later account.
    emailAndPassword: { enabled: true, disableSignUp: false },
    user: {
      additionalFields: {
        role: { type: ['admin', 'member'], defaultValue: 'member', input: false },
        enabled: { type: 'boolean', defaultValue: true, input: false },
      },
    },
    account: {
      accountLinking: { enabled: true, disableImplicitLinking: true },
      encryptOAuthTokens: true,
    },
    databaseHooks: {
      user: {
        create: {
          // Closed registration: refuse early once any account exists. The empty-deployment
          // race is settled in `after`.
          before: async () => {
            if (!options.registration && (await hasUsers(options.db)))
              throw new APIError('FORBIDDEN', { message: '账号注册已关闭' });
          },
          // Runs after the insert commits: the first account of an empty deployment becomes
          // administrator; any later account (or any account in a deployment that already
          // has users) stays a member. With registration closed only that first account is
          // kept: a concurrent sign-up that lost the race is removed again and refused.
          after: async (created) => {
            const promoted = await promoteFirstUser(options.db, created.id);
            if (!options.registration && !promoted) {
              await removeUser(options.db, created.id);
              throw new APIError('FORBIDDEN', { message: '账号注册已关闭' });
            }
          },
        },
      },
      session: {
        create: {
          before: async (session) => {
            const user = await options.db.query.user.findFirst({
              where: (table, { eq }) => eq(table.id, session.userId),
            });
            if (!user?.enabled) throw new APIError('FORBIDDEN', { message: '账号已停用或不存在' });
          },
        },
      },
    },
    socialProviders: {
      ...(options.providers?.google
        ? { google: { ...options.providers.google, disableSignUp: false } }
        : {}),
      ...(options.providers?.github
        ? { github: { ...options.providers.github, disableSignUp: false } }
        : {}),
    },
    plugins: [
      genericOAuth({
        config: options.providers?.oidc
          ? [
              {
                ...options.providers.oidc,
                disableSignUp: false,
                providerId: 'oidc',
                scopes: ['openid', 'profile', 'email'],
                pkce: true,
                getUserInfo: oidcUserInfo(options.providers.oidc, options.fetch ?? fetch),
              },
            ]
          : [],
      }),
    ],
    ...(options.rateLimit
      ? {
          rateLimit: {
            enabled: options.rateLimit.enabled,
            storage: 'memory' as const,
            customRules:
              options.rateLimit.loginPerMinute > 0
                ? {
                    '/sign-in/*': { window: 60, max: options.rateLimit.loginPerMinute },
                    '/sign-up/*': { window: 60, max: options.rateLimit.loginPerMinute },
                  }
                : { '/sign-in/*': false as const, '/sign-up/*': false as const },
          },
        }
      : {}),
    advanced: {
      // The server resolves the client address (trusted proxies only) and passes it in this
      // header; the raw X-Forwarded-For is client-controlled and is not used.
      ipAddress: { ipAddressHeaders: [clientIpHeader] },
      defaultCookieAttributes: {
        sameSite: 'lax',
        httpOnly: true,
        secure: options.baseURL.startsWith('https:'),
      },
    },
  });
}
export type Auth = ReturnType<typeof createAuth>;
export const clientIpHeader = 'x-platform-client-ip';
