import { promoteFirstUser, type Database } from '@platform/db';
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
}) {
  return betterAuth({
    database: drizzleAdapter(options.db, { provider: 'pg', schema }),
    baseURL: options.baseURL,
    basePath: '/api/v1/auth',
    secret: options.secret,
    trustedOrigins: [options.webOrigin],
    emailAndPassword: { enabled: true, disableSignUp: !options.registration },
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
          before: async () => {
            if (!options.registration)
              throw new APIError('FORBIDDEN', { message: '账号注册已关闭' });
          },
          // Runs after the insert commits: the first account of an empty deployment becomes
          // administrator; any later account (or any account in a deployment that already
          // has users) stays a member.
          after: async (created) => {
            await promoteFirstUser(options.db, created.id);
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
        ? { google: { ...options.providers.google, disableSignUp: !options.registration } }
        : {}),
      ...(options.providers?.github
        ? { github: { ...options.providers.github, disableSignUp: !options.registration } }
        : {}),
    },
    plugins: [
      genericOAuth({
        config: options.providers?.oidc
          ? [
              {
                ...options.providers.oidc,
                disableSignUp: !options.registration,
                providerId: 'oidc',
                scopes: ['openid', 'profile', 'email'],
                pkce: true,
                getUserInfo: oidcUserInfo(options.providers.oidc, options.fetch ?? fetch),
              },
            ]
          : [],
      }),
    ],
    advanced: {
      defaultCookieAttributes: {
        sameSite: 'lax',
        httpOnly: true,
        secure: options.baseURL.startsWith('https:'),
      },
    },
  });
}
export type Auth = ReturnType<typeof createAuth>;
