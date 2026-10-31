import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, expect, test } from 'vitest';
import { asc, sql } from 'drizzle-orm';
import { createDatabase, hasUsers, promoteFirstUser, user } from '../packages/db/src/index.js';
import { createAuth } from '../packages/auth/src/index.js';

/**
 * Each case gets its own schema holding copies of the auth tables, so "an empty deployment"
 * and "a deployment that already has users" are real databases rather than mocks, without
 * touching the shared test database (other files sign up concurrently there).
 */
const url = process.env.DATABASE_URL;
if (!url) throw new Error('Tests require a migrated PostgreSQL DATABASE_URL');
const admin = createDatabase(url);
const schemas: string[] = [];
const pools: { end(): Promise<void> }[] = [];
const origin = 'http://localhost:4301';
const baseURL = 'http://localhost:4300';

async function deployment(options: { registration?: boolean } = {}) {
  const schema = `first_admin_${randomUUID().replaceAll('-', '')}`;
  schemas.push(schema);
  await admin.pool.query(`create schema "${schema}"`);
  for (const table of ['user', 'session', 'account', 'verification'])
    await admin.pool.query(
      `create table "${schema}"."${table}" (like public."${table}" including all)`,
    );
  // LIKE does not copy foreign keys; restore the real cascades so removals behave as in production.
  for (const table of ['session', 'account'])
    await admin.pool.query(
      `alter table "${schema}"."${table}" add foreign key ("user_id") references "${schema}"."user"("id") on delete cascade`,
    );
  const separator = url!.includes('?') ? '&' : '?';
  const { db, pool } = createDatabase(
    `${url}${separator}options=${encodeURIComponent(`-c search_path=${schema}`)}`,
  );
  pools.push(pool);
  const auth = createAuth({
    db,
    baseURL,
    webOrigin: origin,
    secret: randomBytes(32).toString('hex'),
    registration: options.registration ?? true,
  });
  async function signup(email = `${randomUUID()}@example.test`) {
    const response = await auth.handler(
      new Request(`${baseURL}/api/v1/auth/sign-up/email`, {
        method: 'POST',
        headers: { Origin: origin, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'New', email, password: randomBytes(12).toString('hex') }),
      }),
    );
    const data = (await response.json()) as { user?: { id: string } };
    return { status: response.status, id: data.user?.id };
  }
  const roles = async () =>
    db
      .select({ id: user.id, email: user.email, role: user.role })
      .from(user)
      .orderBy(asc(user.createdAt), asc(user.id));
  return { db, signup, roles };
}

afterAll(async () => {
  for (const pool of pools) await pool.end();
  for (const schema of schemas) await admin.pool.query(`drop schema "${schema}" cascade`);
  await admin.pool.end();
});

test('the first account of an empty deployment becomes admin; later ones stay members', async () => {
  const d = await deployment();
  const first = await d.signup();
  const second = await d.signup();
  expect([first.status, second.status]).toEqual([200, 200]);
  expect((await d.roles()).map((row) => [row.id, row.role])).toEqual([
    [first.id, 'admin'],
    [second.id, 'member'],
  ]);
});

test('concurrent first sign-ups promote exactly one account, the earliest', async () => {
  for (let round = 0; round < 3; round += 1) {
    const d = await deployment();
    const results = await Promise.all(Array.from({ length: 8 }, () => d.signup()));
    expect(results.every((result) => result.status === 200)).toBe(true);
    const rows = await d.roles();
    expect(rows).toHaveLength(8);
    expect(rows.filter((row) => row.role === 'admin').map((row) => row.id)).toEqual([rows[0]!.id]);
  }
});

test('promotion check itself is race-safe when called concurrently for every account', async () => {
  const d = await deployment();
  const ids = Array.from({ length: 10 }, () => randomUUID());
  await d.db
    .insert(user)
    .values(ids.map((id) => ({ id, name: 'Raced', email: `${id}@example.test` })));
  const promoted = await Promise.all(ids.map((id) => promoteFirstUser(d.db, id)));
  expect(promoted.filter(Boolean)).toHaveLength(1);
  const rows = await d.roles();
  expect(rows.filter((row) => row.role === 'admin').map((row) => row.id)).toEqual([rows[0]!.id]);
});

test('a deployment that already has users never promotes or demotes anyone', async () => {
  // Upgraded deployment where nobody was ever promoted: still no admin afterwards.
  const noAdmin = await deployment();
  const old = randomUUID();
  await noAdmin.db.insert(user).values({
    id: old,
    name: 'Existing',
    email: `${old}@example.test`,
    createdAt: new Date('2025-01-01T00:00:00Z'),
  });
  const newcomer = await noAdmin.signup();
  expect(newcomer.status).toBe(200);
  expect((await noAdmin.roles()).map((row) => [row.id, row.role])).toEqual([
    [old, 'member'],
    [newcomer.id, 'member'],
  ]);
  // Upgraded deployment that already has an admin: roles stay exactly as they were.
  const withAdmin = await deployment();
  const [existingAdmin, existingMember] = [randomUUID(), randomUUID()];
  await withAdmin.db.insert(user).values([
    {
      id: existingMember,
      name: 'Member',
      email: `${existingMember}@example.test`,
      createdAt: new Date('2025-01-01T00:00:00Z'),
    },
    {
      id: existingAdmin,
      name: 'Admin',
      email: `${existingAdmin}@example.test`,
      role: 'admin',
      createdAt: new Date('2025-02-01T00:00:00Z'),
    },
  ]);
  const later = await withAdmin.signup();
  expect((await withAdmin.roles()).map((row) => [row.id, row.role])).toEqual([
    [existingMember, 'member'],
    [existingAdmin, 'admin'],
    [later.id, 'member'],
  ]);
});

test('closed registration still lets the first account of an empty deployment in, as admin', async () => {
  const d = await deployment({ registration: false });
  expect(await hasUsers(d.db)).toBe(false);
  const first = await d.signup();
  expect(first.status).toBe(200);
  expect(await hasUsers(d.db)).toBe(true);
  // The second account is governed by ALLOW_REGISTRATION again.
  const second = await d.signup();
  expect(second.status).toBe(403);
  expect((await d.roles()).map((row) => [row.id, row.role])).toEqual([[first.id, 'admin']]);
});

test('closed registration: concurrent first sign-ups keep exactly one account, the admin', async () => {
  for (let round = 0; round < 3; round += 1) {
    const d = await deployment({ registration: false });
    const results = await Promise.all(Array.from({ length: 8 }, () => d.signup()));
    const accepted = results.filter((result) => result.status === 200);
    expect(accepted).toHaveLength(1);
    expect(results.filter((result) => result.status === 403)).toHaveLength(7);
    expect((await d.roles()).map((row) => [row.id, row.role])).toEqual([
      [accepted[0]!.id, 'admin'],
    ]);
    // Refused sign-ups leave nothing behind: one credential account, sessions only for it.
    const leftovers = await d.db.execute<{ accounts: number; sessions: number }>(
      sql`select (select count(*)::int from account) as accounts, (select count(*)::int from session where user_id <> ${accepted[0]!.id}) as sessions`,
    );
    expect(leftovers.rows[0]).toEqual({ accounts: 1, sessions: 0 });
  }
});

test('closed registration on an upgraded deployment with users refuses every sign-up', async () => {
  const d = await deployment({ registration: false });
  const old = randomUUID();
  await d.db.insert(user).values({ id: old, name: 'Existing', email: `${old}@example.test` });
  expect((await d.signup()).status).toBe(403);
  expect((await d.roles()).map((row) => [row.id, row.role])).toEqual([[old, 'member']]);
});
