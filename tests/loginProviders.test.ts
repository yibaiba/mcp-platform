import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { expect, test } from 'vitest';
import { user, account } from '../packages/db/src/index.js';
import { harness } from './harness.js';
import { UserService } from '../apps/server/src/modules/users/userService.js';
import { createAuth } from '../packages/auth/src/index.js';

test.each([true, false])(
  'OIDC honors registration=%s and retains existing identity login without implicit linking',
  async (registration) => {
    const app = new Hono();
    let subject = randomUUID();
    const email = `${randomUUID()}@example.test`;
    let infoRequests = 0;
    let issuer = '';
    app.get('/.well-known/openid-configuration', (c) =>
      c.json({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        userinfo_endpoint: `${issuer}/userinfo`,
      }),
    );
    app.post('/token', async (c) => {
      const input = new URLSearchParams(await c.req.text());
      expect(input.get('code_verifier')).toBeTruthy();
      return c.json({
        access_token: 'fixture-userinfo-token',
        token_type: 'Bearer',
        expires_in: 60,
      });
    });
    app.get('/userinfo', (c) => {
      expect(c.req.header('authorization')).toBe('Bearer fixture-userinfo-token');
      infoRequests++;
      return c.json({ sub: subject, email, email_verified: false, name: 'OIDC member' });
    });
    const server = serve({ fetch: app.fetch, port: 0 });
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No fixture port');
    issuer = `http://localhost:${address.port}`;
    const h = await harness({
      registration,
      providers: {
        oidc: {
          name: 'Test identity',
          issuer,
          discoveryUrl: `${issuer}/.well-known/openid-configuration`,
          clientId: 'client',
          clientSecret: 'fixture-client-secret',
        },
      },
    });
    const cookie = (response: Response) =>
      response.headers
        .getSetCookie()
        .map((v) => v.split(';')[0])
        .join('; ');
    const signIn = async (requestSignUp = false) => {
      const start = await h.app.request('/api/v1/auth/sign-in/oauth2', {
        method: 'POST',
        headers: { Origin: h.config.WEB_ORIGIN, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          providerId: 'oidc',
          callbackURL: h.config.WEB_ORIGIN,
          requestSignUp,
        }),
      });
      expect(start.status).toBe(200);
      const redirect = new URL(((await start.json()) as { url: string }).url);
      expect(redirect.searchParams.get('code_challenge_method')).toBe('S256');
      const query = new URLSearchParams({
        code: randomUUID(),
        state: redirect.searchParams.get('state')!,
        iss: issuer,
      });
      return h.app.request(`/api/v1/auth/oauth2/callback/oidc?${query}`, {
        headers: { Cookie: cookie(start) },
      });
    };
    try {
      if (!registration) {
        for (const explicit of [false, true]) {
          const denied = await signIn(explicit);
          expect(denied.headers.get('location')).toContain('error=');
          expect(
            denied.headers.getSetCookie().some((value) => value.includes('session_token=')),
          ).toBe(false);
          expect(await h.db.select().from(user).where(eq(user.email, email))).toHaveLength(0);
        }
        const id = randomUUID();
        await h.db
          .insert(user)
          .values({ id, email, name: 'Provisioned member', emailVerified: false });
        await h.db
          .insert(account)
          .values({ id: randomUUID(), userId: id, providerId: 'oidc', accountId: subject });
      }
      const first = await signIn();
      expect(first.status).toBe(302);
      expect(first.headers.get('location')).toBe(h.config.WEB_ORIGIN);
      const [created] = await h.db.select().from(user).where(eq(user.email, email));
      expect(created).toMatchObject({ role: 'member', enabled: true, emailVerified: false });
      const [binding] = await h.db
        .select()
        .from(account)
        .where(and(eq(account.providerId, 'oidc'), eq(account.accountId, subject)));
      expect(binding?.userId).toBe(created!.id);
      expect((await signIn()).headers.get('location')).toBe(h.config.WEB_ORIGIN);
      subject = randomUUID();
      const conflicting = await signIn();
      expect(conflicting.headers.get('location')).toContain('error=');
      expect(await h.db.select().from(account).where(eq(account.accountId, subject))).toHaveLength(
        0,
      );
      expect(infoRequests).toBe(registration ? 3 : 5);
      const metadata = await (await h.app.request('/api/v1/login-options')).json();
      expect(JSON.stringify(metadata)).not.toContain('fixture-client-secret');
      expect(metadata).toMatchObject({
        providers: [{ id: 'oidc', name: 'Test identity', kind: 'oauth2' }],
      });
    } finally {
      await h.db.delete(user).where(eq(user.email, email));
      await h.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);

test('closed registration rejects provider-independent user creation while admin provisioning and login remain available', async () => {
  const h = await harness({ registration: false });
  const email = `${randomUUID()}@example.test`;
  const adminId = randomUUID();
  const auth = createAuth({
    db: h.db,
    baseURL: h.baseURL,
    webOrigin: h.config.WEB_ORIGIN,
    secret: h.config.BETTER_AUTH_SECRET,
    registration: false,
  });
  try {
    const context = await auth.$context;
    await expect(
      context.internalAdapter.createUser({
        email,
        name: 'Verified provider user',
        emailVerified: true,
      }),
    ).rejects.toThrow('账号注册已关闭');
    expect(await h.db.select().from(user).where(eq(user.email, email))).toHaveLength(0);
    await h.db.insert(user).values({
      id: adminId,
      email: `${adminId}@example.test`,
      name: 'Admin',
      role: 'admin',
    });
    const password = randomUUID();
    const users = new UserService({
      db: h.db,
      hashPassword: context.password.hash,
      disabled: async () => {},
    });
    await users.create(adminId, {
      email,
      name: 'Provisioned member',
      password,
      role: 'member',
      enabled: true,
    });
    const signedIn = await h.app.request('/api/v1/auth/sign-in/email', {
      method: 'POST',
      headers: { Origin: h.config.WEB_ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    expect(signedIn.status).toBe(200);
  } finally {
    await h.db.delete(user).where(eq(user.email, email));
    await h.db.delete(user).where(eq(user.id, adminId));
    await h.close();
  }
});
