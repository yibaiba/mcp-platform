import { afterAll, beforeAll, expect, test } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { connectionShares, user } from '../packages/db/src/index.js';
import { harness } from './harness.js';
import { fixtureMcp } from './fixtureMcp.js';

// Team grants ("share with every account") and their permission boundaries.
let h: Awaited<ReturnType<typeof harness>>;
let upstream: Awaited<ReturnType<typeof fixtureMcp>>;
let admin: Awaited<ReturnType<typeof h.signup>>;
let member: typeof admin;
let otherAdmin: typeof admin;
const seenHeaders: (string | null)[] = [];
const SECRET = 'Bearer admin-team-secret';
beforeAll(async () => {
  h = await harness();
  upstream = await fixtureMcp({
    onRequest: (req) => seenHeaders.push(req.headers.get('authorization')),
  });
  admin = await h.signup({ role: 'admin' });
  member = await h.signup();
  otherAdmin = await h.signup({ role: 'admin' });
});
afterAll(async () => {
  await h?.close();
  await upstream?.close();
});

async function source(name = 'team source') {
  const connection = await h.services.connections.create(admin.ownerId, {
    name,
    adapter: 'direct',
    transport: 'http',
    mode: 'existing',
    url: upstream.url,
    headers: { Authorization: SECRET },
  });
  const tools = await h.services.connections.discover(admin.ownerId, connection.id);
  return { connection, tools };
}
async function shareTeam(
  connectionId: string,
  body: { credentialMode?: 'independent' | 'owner'; toolIds: string[]; version?: number },
  account = admin,
) {
  return account.request(`/connections/${connectionId}/team-share`, {
    method: 'PUT',
    body: JSON.stringify(body),
  });
}
async function incoming(account: typeof admin, connectionId: string) {
  const rows = (await (await account.request('/shares')).json()) as {
    id: string;
    connectionId: string;
    credentialMode: string;
    toolIds: string[];
    teamShareId: string | null;
    status: string;
  }[];
  return rows.find((row) => row.connectionId === connectionId);
}
async function emailOf(account: typeof admin) {
  const [row] = await h.db.select().from(user).where(eq(user.id, account.ownerId));
  return row!.email;
}

test('only admins share with everyone; audience is every enabled account except the owner, including later ones', async () => {
  const { connection, tools } = await source();
  const toolIds = [tools[0]!.id];
  expect((await shareTeam(connection.id, { toolIds }, member)).status).toBe(404);
  const memberConnection = await h.services.connections.create(member.ownerId, {
    name: 'member source',
    adapter: 'direct',
    transport: 'http',
    mode: 'existing',
    url: upstream.url,
  });
  const forbidden = await shareTeam(memberConnection.id, { toolIds: [] }, member);
  expect(forbidden.status).toBe(403);
  expect(await forbidden.json()).toMatchObject({ code: 'TEAM_SHARE_ADMIN_ONLY' });

  const disabled = await h.signup();
  await h.db.update(user).set({ enabled: false }).where(eq(user.id, disabled.ownerId));
  const response = await shareTeam(connection.id, { toolIds });
  expect(response.status).toBe(200);
  // 1C: independent is the default mode for a team grant.
  expect(await response.json()).toMatchObject({ credentialMode: 'independent', toolIds });

  for (const account of [member, otherAdmin])
    expect(await incoming(account, connection.id)).toMatchObject({
      credentialMode: 'independent',
      toolIds,
      status: 'pending',
      teamShareId: expect.any(String),
    });
  expect(await incoming(admin, connection.id)).toBeUndefined();
  expect(await h.services.shares.grants(admin.ownerId)).toEqual(
    expect.not.arrayContaining([expect.objectContaining({ connectionId: connection.id })]),
  );
  // Disabled accounts are not in the audience, at save time or afterwards.
  expect(
    (await h.services.shares.grants(disabled.ownerId)).some(
      (g) => g.connectionId === connection.id,
    ),
  ).toBe(false);
  // An account created after the grant is included automatically.
  const later = await h.signup();
  expect(await incoming(later, connection.id)).toMatchObject({
    toolIds,
    teamShareId: expect.any(String),
  });
  // Re-enabling restores membership; disabling an existing member removes it immediately.
  await h.db.update(user).set({ enabled: true }).where(eq(user.id, disabled.ownerId));
  expect(
    (await h.services.shares.grants(disabled.ownerId)).some(
      (g) => g.connectionId === connection.id,
    ),
  ).toBe(true);
  await h.db.update(user).set({ enabled: false }).where(eq(user.id, later.ownerId));
  expect(
    (await h.services.shares.grants(later.ownerId)).some((g) => g.connectionId === connection.id),
  ).toBe(false);
  const summary = await (await admin.request(`/connections/${connection.id}/team-share`)).json();
  expect(summary).toMatchObject({ revoked: false, credentialMode: 'independent' });
  expect(summary.members).toBeGreaterThanOrEqual(3);
  // A member deleted from the platform loses the grant with the account (cascade).
  await h.db.delete(user).where(eq(user.id, disabled.ownerId));
  expect(
    await h.db
      .select()
      .from(connectionShares)
      .where(
        and(
          eq(connectionShares.connectionId, connection.id),
          eq(connectionShares.recipientId, disabled.ownerId),
        ),
      ),
  ).toEqual([]);
});

test('independent team grants never expose or use the admin credentials; owner mode is explicit', async () => {
  const { connection, tools } = await source();
  const toolId = tools[0]!.id;
  await shareTeam(connection.id, { toolIds: [toolId] });
  const raw = await (await member.request('/shares')).text();
  expect(raw).not.toContain('admin-team-secret');
  const outgoing = await (await admin.request(`/connections/${connection.id}/shares`)).text();
  expect(outgoing).not.toContain('admin-team-secret');
  const profile = (await h.services.profiles.save(member.ownerId, {
    name: 'team agent',
    toolIds: [toolId],
  }))!;
  seenHeaders.length = 0;
  // Pending independent grant: the call must not reach upstream with the admin's header.
  await h.services.invocations
    .call({ ownerId: member.ownerId, profileId: profile.id, toolId, arguments: {} })
    .catch(() => undefined);
  expect(seenHeaders).not.toContain(SECRET);

  const summary = await (await admin.request(`/connections/${connection.id}/team-share`)).json();
  expect(
    (
      await shareTeam(connection.id, {
        credentialMode: 'owner',
        toolIds: [toolId],
        version: summary.version,
      })
    ).status,
  ).toBe(200);
  expect(await incoming(member, connection.id)).toMatchObject({ credentialMode: 'owner' });
  // Owner mode delegates the call, never the secret.
  expect(await (await member.request('/shares')).text()).not.toContain('admin-team-secret');
  const share = await incoming(member, connection.id);
  const credentials = await member.request(`/shares/${share!.id}/configuration`, {
    method: 'PUT',
    body: JSON.stringify({ headers: { Authorization: 'Bearer stolen' } }),
  });
  expect(credentials.ok).toBe(false);
  await expect(
    h.services.invocations.call({
      ownerId: member.ownerId,
      profileId: profile.id,
      toolId,
      arguments: {},
    }),
  ).resolves.toMatchObject({ structuredContent: { name: 'echo' } });
});

test('4A: a direct grant outranks the team grant in both directions', async () => {
  const { connection, tools } = await source();
  // The fixture exposes one tool: the team grant starts with none, the direct grant has it.
  const a = tools[0]!.id;
  const direct = await admin.request(`/connections/${connection.id}/shares`, {
    method: 'PUT',
    body: JSON.stringify({
      recipientEmail: await emailOf(member),
      credentialMode: 'owner',
      toolIds: [a],
    }),
  });
  expect(direct.status).toBe(200);
  await shareTeam(connection.id, { toolIds: [] });
  expect(await incoming(member, connection.id)).toMatchObject({
    credentialMode: 'owner',
    toolIds: [a],
    teamShareId: null,
  });
  expect(await incoming(otherAdmin, connection.id)).toMatchObject({
    credentialMode: 'independent',
    toolIds: [],
  });
  // Editing the team grant leaves the direct grant alone.
  const team = await (await admin.request(`/connections/${connection.id}/team-share`)).json();
  await shareTeam(connection.id, { credentialMode: 'owner', toolIds: [a], version: team.version });
  expect(await incoming(member, connection.id)).toMatchObject({ toolIds: [a], teamShareId: null });
  expect(await incoming(otherAdmin, connection.id)).toMatchObject({
    credentialMode: 'owner',
    toolIds: [a],
  });
  await shareTeam(connection.id, { toolIds: [], version: team.version + 1 });
  // Revoking the direct grant falls back to the team grant, and says so.
  const { id } = await direct.json();
  const revoked = await admin.request(`/connections/${connection.id}/shares/${id}`, {
    method: 'DELETE',
  });
  expect(await revoked.json()).toEqual({ revoked: true, fallback: 'team' });
  expect(await incoming(member, connection.id)).toMatchObject({
    credentialMode: 'independent',
    teamShareId: team.id,
  });
  // A direct grant onto a team copy converts it (no version needed) and wins again.
  const again = await admin.request(`/connections/${connection.id}/shares`, {
    method: 'PUT',
    body: JSON.stringify({ recipientEmail: await emailOf(otherAdmin), toolIds: [a] }),
    // no version: replacing a team copy
  });
  expect(again.status).toBe(200);
  expect(await incoming(otherAdmin, connection.id)).toMatchObject({
    toolIds: [a],
    teamShareId: null,
  });
  // Ending the team grant does not touch direct grants.
  await admin.request(`/connections/${connection.id}/team-share`, { method: 'DELETE' });
  expect(await incoming(otherAdmin, connection.id)).toMatchObject({ toolIds: [a] });
  expect(await incoming(member, connection.id)).toBeUndefined();
});

test('ending the team grant or excluding one account invalidates Agent tools immediately with a clear error', async () => {
  const { connection, tools } = await source();
  const toolId = tools[0]!.id;
  await shareTeam(connection.id, { credentialMode: 'owner', toolIds: [toolId] });
  const profiles = await Promise.all(
    [member, otherAdmin].map(
      async (account) =>
        (await h.services.profiles.save(account.ownerId, {
          name: 'uses team',
          toolIds: [toolId],
        }))!,
    ),
  );
  for (const [i, account] of [member, otherAdmin].entries())
    await expect(
      h.services.invocations.call({
        ownerId: account.ownerId,
        profileId: profiles[i]!.id,
        toolId,
        arguments: {},
      }),
    ).resolves.toMatchObject({ structuredContent: { name: 'echo' } });

  // Exclude one account: only that account loses access, at once.
  const share = await incoming(member, connection.id);
  const excluded = await admin.request(`/connections/${connection.id}/shares/${share!.id}`, {
    method: 'DELETE',
  });
  expect(await excluded.json()).toEqual({ revoked: true, fallback: null });
  expect(await h.services.profiles.catalog(member.ownerId, profiles[0]!.id)).toEqual([]);
  await expect(
    h.services.invocations.call({
      ownerId: member.ownerId,
      profileId: profiles[0]!.id,
      toolId,
      arguments: {},
    }),
  ).rejects.toMatchObject({ code: 'SHARE_ACCESS_ENDED', status: 403 });
  await expect(
    h.services.invocations.call({
      ownerId: otherAdmin.ownerId,
      profileId: profiles[1]!.id,
      toolId,
      arguments: {},
    }),
  ).resolves.toMatchObject({ structuredContent: { name: 'echo' } });
  // The exclusion survives edits of the team grant and later reads.
  const team = await (await admin.request(`/connections/${connection.id}/team-share`)).json();
  expect(team.excluded).toBe(1);
  await shareTeam(connection.id, {
    credentialMode: 'owner',
    toolIds: [toolId],
    version: team.version,
  });
  expect(await incoming(member, connection.id)).toBeUndefined();

  // Ending the team grant cuts everyone off at once.
  const ended = await admin.request(`/connections/${connection.id}/team-share`, {
    method: 'DELETE',
  });
  expect(ended.status).toBe(200);
  expect(await h.services.profiles.catalog(otherAdmin.ownerId, profiles[1]!.id)).toEqual([]);
  await expect(
    h.services.invocations.call({
      ownerId: otherAdmin.ownerId,
      profileId: profiles[1]!.id,
      toolId,
      arguments: {},
    }),
  ).rejects.toMatchObject({ code: 'SHARE_ACCESS_ENDED' });
  // The admin's own access is untouched.
  await expect(
    h.services.invocations.call({ ownerId: admin.ownerId, toolId, arguments: {} }),
  ).resolves.toMatchObject({ structuredContent: { name: 'echo' } });
  // Sharing with everyone again starts fresh: earlier exclusions are cleared.
  await shareTeam(connection.id, { credentialMode: 'owner', toolIds: [toolId] });
  expect(await incoming(member, connection.id)).toMatchObject({ teamShareId: team.id });
});
