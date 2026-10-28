import { z } from 'zod';

const client = z.object({ clientId: z.string().min(1), clientSecret: z.string().min(1) }).strict();
export const providerConfig = z
  .object({
    google: client.optional(),
    github: client.optional(),
    oidc: client
      .extend({
        name: z.string().min(1),
        discoveryUrl: z.url(),
        issuer: z.url(),
      })
      .optional(),
  })
  .strict();
export type ProviderConfig = z.infer<typeof providerConfig>;
const discovery = z.object({ issuer: z.string(), userinfo_endpoint: z.url() });
const identity = z.object({
  sub: z.string().min(1),
  email: z.email(),
  name: z.string().min(1),
  email_verified: z.boolean().optional(),
  picture: z.url().optional(),
});

// Better Auth 1.6 uses decoded ID-token claims by default. Resolve identity through
// the configured issuer's authenticated UserInfo endpoint instead.
export function oidcUserInfo(config: NonNullable<ProviderConfig['oidc']>, fetcher: typeof fetch) {
  return async (tokens: { accessToken?: string }) => {
    if (!tokens.accessToken) throw new Error('OIDC token response has no access token');
    const response = await fetcher(config.discoveryUrl);
    if (!response.ok) throw new Error(`OIDC discovery failed (${response.status})`);
    const metadata = discovery.parse(await response.json());
    if (metadata.issuer !== config.issuer) throw new Error('OIDC discovery issuer mismatch');
    const info = await fetcher(metadata.userinfo_endpoint, {
      headers: { Authorization: `Bearer ${tokens.accessToken}` },
    });
    if (!info.ok) throw new Error(`OIDC UserInfo failed (${info.status})`);
    const profile = identity.parse(await info.json());
    return {
      id: profile.sub,
      email: profile.email,
      name: profile.name,
      emailVerified: profile.email_verified === true,
      image: profile.picture,
    };
  };
}
export function providerList(config: ProviderConfig = {}) {
  return [
    ...(config.google ? [{ id: 'google', name: 'Google', kind: 'social' }] : []),
    ...(config.github ? [{ id: 'github', name: 'GitHub', kind: 'social' }] : []),
    ...(config.oidc ? [{ id: 'oidc', name: config.oidc.name, kind: 'oauth2' }] : []),
  ];
}
