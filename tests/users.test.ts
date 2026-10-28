import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { eq } from 'drizzle-orm';
import { user, calls, accessKeys, oauthClients, oauthGrants } from '../packages/db/src/index.js';
import { digest } from '../apps/server/src/shared/crypto.js';
import { harness } from './harness.js';
import { fixtureMcp } from './fixtureMcp.js';

let h: Awaited<ReturnType<typeof harness>>;
let admin: Awaited<ReturnType<typeof h.signup>>;
const created: string[] = [];
beforeAll(async () => {
  h = await harness();
  admin = await h.signup();
  await h.db.update(user).set({ role: 'admin' }).where(eq(user.id, admin.ownerId));
});
afterAll(async () => {
  for (const id of created) await h.db.delete(user).where(eq(user.id, id));
  await h.close();
});

async function createMember() {
  const email = `${randomUUID()}@example.test`;
  const password = `test-${randomUUID()}`;
  const response = await admin.request('/admin/users', {
    method: 'POST',
    body: JSON.stringify({ email, password, name: 'Member', role: 'member', enabled: true }),
  });
  expect(response.status).toBe(201);
  const row = (await response.json()) as { id: string };
  created.push(row.id);
  return { id: row.id, email, password };
}
async function login(account: { email: string; password: string }) {
  return h.app.request('/api/v1/auth/sign-in/email', {
    method: 'POST',
    headers: { Origin: h.config.WEB_ORIGIN, 'Content-Type': 'application/json' },
    body: JSON.stringify(account),
  });
}
const cookie = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((v) => v.split(';')[0])
    .join('; ');

test('registration cannot grant admin and ordinary users cannot administer another account', async () => {
  const member = await h.signup();
  expect(await (await member.request('/me')).json()).toMatchObject({ role: 'member' });
  expect((await member.request('/admin/users')).status).toBe(403);
  expect(
    (
      await member.request(`/admin/users/${admin.ownerId}`, {
        method: 'PATCH',
        body: JSON.stringify({ role: 'member' }),
      })
    ).status,
  ).toBe(403);
  const update = await member.request('/auth/update-user', {
    method: 'POST',
    body: JSON.stringify({ role: 'admin', enabled: true, name: 'Attempted escalation' }),
  });
  expect(update.status).toBe(400);
  expect(await (await member.request('/me')).json()).toMatchObject({ role: 'member' });
});

test('admin creation, editing, credential hashing, personal password change and session revocation', async () => {
  const member = await createMember();
  const signed = await login(member);
  expect(signed.status).toBe(200);
  const headers = {
    Cookie: cookie(signed),
    Origin: h.config.WEB_ORIGIN,
    'Content-Type': 'application/json',
  };
  const second = await login(member);
  const changed = await h.app.request('/api/v1/auth/change-password', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      currentPassword: member.password,
      newPassword: 'updated-password-123',
      revokeOtherSessions: true,
    }),
  });
  expect(changed.status).toBe(200);
  expect((await login(member)).status).toBe(401);
  expect((await h.app.request('/api/v1/me', { headers: { Cookie: cookie(second) } })).status).toBe(
    401,
  );
  expect(
    (
      await admin.request(`/admin/users/${member.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: 'Renamed' }),
      })
    ).status,
  ).toBe(200);
  expect(
    (await admin.request(`/admin/users/${member.id}/sessions`, { method: 'DELETE' })).status,
  ).toBe(200);
  expect((await h.app.request('/api/v1/me', { headers })).status).toBe(401);
});

test('disabling blocks login, existing sessions, Agent keys and OAuth refresh without restoring revoked keys on enable', async () => {
  const member = await createMember();
  const signed = await login(member);
  const profile = await h.services.profiles.save(member.id, { name: 'Private' });
  const key = await h.services.profiles.issue(member.id, profile!.id);
  const [client] = await h.db
    .insert(oauthClients)
    .values({ name: 'test', redirects: ['http://localhost/cb'] })
    .returning();
  const access = randomUUID(),
    refresh = randomUUID();
  try {
    await h.db.insert(oauthGrants).values({
      ownerId: member.id,
      profileId: profile!.id,
      clientId: client!.id,
      accessHash: digest(access),
      refreshHash: digest(refresh),
      expiresAt: new Date(Date.now() + 60_000),
      refreshExpiresAt: new Date(Date.now() + 120_000),
    });
    expect(
      (
        await admin.request(`/admin/users/${member.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ enabled: false }),
        })
      ).status,
    ).toBe(200);
    expect((await login(member)).status).toBe(403);
    expect(
      (await h.app.request('/api/v1/me', { headers: { Cookie: cookie(signed) } })).status,
    ).toBe(401);
    await expect(h.services.profiles.authenticate(profile!.id, key.token)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    await expect(h.services.profiles.authenticate(profile!.id, access)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    await expect(
      h.services.agentOAuth.token({
        grant_type: 'refresh_token',
        client_id: client!.id,
        refresh_token: refresh,
        resource: `${h.baseURL}/mcp/${profile!.id}`,
      }),
    ).rejects.toThrow();
    await admin.request(`/admin/users/${member.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled: true }),
    });
    expect((await login(member)).status).toBe(200);
    const [stored] = await h.db.select().from(accessKeys).where(eq(accessKeys.id, key.id));
    expect(stored?.revoked).toBe(true);
  } finally {
    await h.db.delete(oauthGrants).where(eq(oauthGrants.clientId, client!.id));
    await h.db.delete(oauthClients).where(eq(oauthClients.id, client!.id));
  }
});

test('disable interrupts a real in-flight call but does not affect another account', async () => {
  const member = await createMember();
  const fixture = await fixtureMcp();
  try {
    const connection = await h.services.connections.create(member.id, {
      name: 'active',
      adapter: 'direct',
      transport: 'http',
      mode: 'existing',
      url: fixture.url,
    });
    const [tool] = await h.services.connections.discover(member.id, connection.id);
    const outcome = h.services.invocations
      .call({ ownerId: member.id, toolId: tool!.id, arguments: { delay: 2000 } })
      .then(
        () => 'completed',
        () => 'interrupted',
      );
    await expect.poll(fixture.count).toBe(1);
    expect(
      (
        await admin.request(`/admin/users/${member.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ enabled: false }),
        })
      ).status,
    ).toBe(200);
    expect(await outcome).toBe('interrupted');
    const [call] = await h.db.select().from(calls).where(eq(calls.ownerId, member.id));
    expect(call?.status).not.toBe('succeeded');
    expect(fixture.count()).toBe(1);
    expect((await admin.request('/me')).status).toBe(200);
  } finally {
    await fixture.close();
  }
});

test('login discovery returns only configured provider metadata', async () => {
  expect(await (await h.app.request('/api/v1/login-options')).json()).toEqual({
    registration: true,
    providers: [],
  });
});
