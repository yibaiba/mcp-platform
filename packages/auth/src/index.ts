import type { Database } from '@platform/db';
import * as schema from '@platform/db/schema/auth';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
export function createAuth(options: {
  db: Database;
  baseURL: string;
  webOrigin: string;
  secret: string;
  registration: boolean;
}) {
  return betterAuth({
    database: drizzleAdapter(options.db, { provider: 'pg', schema }),
    baseURL: options.baseURL,
    basePath: '/api/v1/auth',
    secret: options.secret,
    trustedOrigins: [options.webOrigin],
    emailAndPassword: { enabled: true, disableSignUp: !options.registration },
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
