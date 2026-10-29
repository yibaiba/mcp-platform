import { beforeAll, afterAll, test, expect, vi } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { localBindings, localOperations, connections, user } from '../packages/db/src/index.js';
import type { LocalResource } from '../packages/contracts/src/index.js';
import { harness } from './harness.js';
import { fixtureConnector } from './fixtureConnector.js';
import { fixtureMcp } from './fixtureMcp.js';
let h: Awaited<ReturnType<typeof harness>>;
let account: Awaited<ReturnType<typeof h.signup>>;
let other: Awaited<ReturnType<typeof h.signup>>;
let connector: Awaited<ReturnType<typeof fixtureConnector>>;
let mcp: Awaited<ReturnType<typeof fixtureMcp>>;
let path: string;
let resource: LocalResource;
const credential = 'local-credential-never-upload';
async function state() {
  return h.services.local.sync.state(connector.deviceId);
}
async function scan() {
  const current = await state();
  await h.services.local.request(account.ownerId, connector.deviceId, {
    action: 'scan',
    operationId: randomUUID(),
    expectedRevision: current.revision,
  });
  await vi.waitFor(async () =>
    expect(
      Object.values((await state()).operations)
        .filter((op) => op.action === 'scan')
        .every((op) => op.phase === 'succeeded'),
    ).toBe(true),
  );
}
async function binding() {
  return (await h.services.local.repository.list(account.ownerId, connector.deviceId)).find(
    (row) => row.resourceId === resource.id,
  )!;
}
async function changeBinding(input: Record<string, unknown>) {
  const row = await binding();
  return h.services.local.mutateBinding(account.ownerId, {
    deviceId: connector.deviceId,
    id: row.id,
    revision: row.revision,
    operationId: randomUUID(),
    action: 'update',
    ...input,
  });
}
beforeAll(async () => {
  h = await harness();
  account = await h.signup();
  other = await h.signup();
  mcp = await fixtureMcp();
  path = join(h.directory, '.cursor', 'mcp.json');
  await mkdir(join(h.directory, '.cursor'), { recursive: true });
  await writeFile(
    path,
    `{// preserved comment\n"theme":"untouched","mcpServers":{"local":{"type":"http","url":${JSON.stringify(mcp.url)},"headers":{"Authorization":"Bearer ${credential}"},"description":"initial"}}}`,
    { mode: 0o600 },
  );
  const skill = join(h.directory, '.agents', 'skills', 'local-example');
  await mkdir(skill, { recursive: true });
  await writeFile(
    join(skill, 'SKILL.md'),
    '---\nname: local-example\ndescription: Local example\n---\nVersion one\n',
  );
  connector = await fixtureConnector(h, account.ownerId);
  resource = Object.values((await state()).resources).find((r) => r.name === 'local')!;
  expect(resource).toBeDefined();
});
afterAll(async () => {
  await connector?.close();
  await h?.close();
  await mcp?.close();
});
test('scan is side-effect free and platform management is isolated by device owner', async () => {
  expect(mcp.count()).toBe(0);
  expect((await h.services.connections.list(account.ownerId)).length).toBe(0);
  const response = await other.request(`/devices/${connector.deviceId}/local`);
  expect(response.status).toBe(404);
  const snapshot = await account.request(`/devices/${connector.deviceId}/local`);
  expect(snapshot.status).toBe(200);
  expect(await snapshot.text()).not.toContain(credential);
});
test('selected resource creates one credential reference and performs a real MCP discovery', async () => {
  const snapshot = await state();
  await h.services.local.request(account.ownerId, connector.deviceId, {
    action: 'select',
    id: resource.id,
    selected: true,
    expectedRevision: snapshot.revision,
    operationId: randomUUID(),
  });
  const row = await binding();
  expect(row.status).toBe('synced');
  expect(row.connectionId).toBeTruthy();
  const context = await h.services.connections.context(account.ownerId, row.connectionId!);
  expect(context.config.deviceResourceId).toBe(resource.id);
  expect(context.config.headers).toEqual({});
  const tools = await h.services.connections.discover(account.ownerId, row.connectionId!);
  expect(tools[0]?.name).toBe('echo');
  expect(mcp.count()).toBe(0);
  const stored = await h.db
    .select()
    .from(localBindings)
    .where(eq(localBindings.deviceId, connector.deviceId));
  const ops = await h.db
    .select()
    .from(localOperations)
    .where(eq(localOperations.deviceId, connector.deviceId));
  expect(JSON.stringify([stored, ops])).not.toContain(credential);
  await h.services.local.serial(connector.deviceId, () =>
    h.services.local.sync.reconcile(account.ownerId, connector.deviceId),
  );
  expect((await h.services.connections.list(account.ownerId)).length).toBe(1);
});
test('sharing a local resource does not grant device management or inherit an independent identity', async () => {
  const row = await binding();
  const [recipient] = await h.db.select().from(user).where(eq(user.id, other.ownerId));
  const tools = await h.services.connections.discover(account.ownerId, row.connectionId!);
  const grant = await h.services.shares.save(account.ownerId, row.connectionId!, {
    recipientEmail: recipient!.email,
    credentialMode: 'owner',
    toolIds: tools.map((tool) => tool.id),
  });
  try {
    expect((await h.services.connections.discover(other.ownerId, row.connectionId!))[0]?.name).toBe(
      'echo',
    );
    expect((await other.request(`/devices/${connector.deviceId}/local`)).status).toBe(404);
    expect(
      (
        await other.request(`/devices/${connector.deviceId}/local/request`, {
          method: 'POST',
          body: JSON.stringify({
            action: 'scan',
            operationId: randomUUID(),
            expectedRevision: (await state()).revision,
          }),
        })
      ).status,
    ).toBe(404);
    await h.services.shares.save(account.ownerId, row.connectionId!, {
      recipientEmail: recipient!.email,
      credentialMode: 'independent',
      toolIds: tools.map((tool) => tool.id),
      version: grant.version,
    });
    await expect(
      h.services.connections.discover(other.ownerId, row.connectionId!),
    ).rejects.toThrow();
    expect(mcp.count()).toBe(0);
  } finally {
    await h.services.shares.revoke(account.ownerId, grant.id);
  }
});
test('platform edits write only selected entries and local credentials remain local', async () => {
  const row = await binding();
  const content = { ...row.content, description: 'from platform' };
  const id = randomUUID();
  const input = {
    deviceId: connector.deviceId,
    id: row.id,
    revision: row.revision,
    operationId: id,
    action: 'update' as const,
    content,
  };
  const first = await h.services.local.mutateBinding(account.ownerId, input);
  const second = await h.services.local.mutateBinding(account.ownerId, input);
  expect(JSON.parse(JSON.stringify(second))).toEqual(JSON.parse(JSON.stringify(first)));
  await h.services.local.serial(connector.deviceId, () =>
    h.services.local.sync.reconcile(account.ownerId, connector.deviceId),
  );
  const data = await readFile(path, 'utf8');
  expect(data).toContain('from platform');
  expect(data).toContain('// preserved comment');
  expect(data).toContain('"theme":"untouched"');
  expect(data).toContain(credential);
  expect((await binding()).status).toBe('synced');
});
test('both-side edits create a conflict and explicit platform resolution preserves credentials', async () => {
  const row = await binding();
  await changeBinding({ content: { ...row.content, description: 'platform conflict' } });
  await writeFile(path, (await readFile(path, 'utf8')).replace('from platform', 'local conflict'));
  await scan();
  await h.services.local.serial(connector.deviceId, () =>
    h.services.local.sync.reconcile(account.ownerId, connector.deviceId),
  );
  expect((await binding()).status).toBe('conflict');
  expect(await readFile(path, 'utf8')).toContain('local conflict');
  await changeBinding({ action: 'resolve', choice: 'platform' });
  await h.services.local.serial(connector.deviceId, () =>
    h.services.local.sync.reconcile(account.ownerId, connector.deviceId),
  );
  expect((await binding()).status).toBe('synced');
  expect(await readFile(path, 'utf8')).toContain('platform conflict');
});
test('credential changes invalidate connection revision without uploading or replaying', async () => {
  const before = await binding();
  const connection = await h.services.connections.owned(account.ownerId, before.connectionId!);
  await writeFile(
    path,
    (await readFile(path, 'utf8')).replace(credential, `${credential}-changed`),
  );
  await scan();
  await h.services.local.serial(connector.deviceId, () =>
    h.services.local.sync.reconcile(account.ownerId, connector.deviceId),
  );
  const after = await h.services.connections.owned(account.ownerId, before.connectionId!);
  expect(after.revision).toBe(connection.revision + 1);
  expect(mcp.count()).toBe(0);
  const dump = await h.services.local.state(account.ownerId, connector.deviceId);
  expect(JSON.stringify(dump)).not.toContain(credential);
});
test('Skill changes create immutable versions without changing pinned Agent grants', async () => {
  const snapshot = await state();
  const skill = Object.values(snapshot.resources).find((r) => r.name === 'local-example')!;
  await h.services.local.request(account.ownerId, connector.deviceId, {
    action: 'select',
    id: skill.id,
    selected: true,
    expectedRevision: snapshot.revision,
    operationId: randomUUID(),
  });
  const initial = (
    await h.services.local.repository.list(account.ownerId, connector.deviceId)
  ).find((r) => r.resourceId === skill.id)!;
  const profile = await h.services.profiles.save(account.ownerId, {
    name: 'Pinned skill',
    skillVersionIds: [initial.skillVersionId!],
  });
  await writeFile(
    join(h.directory, '.agents', 'skills', 'local-example', 'SKILL.md'),
    '---\nname: local-example\ndescription: Local example\n---\nVersion two\n',
  );
  await scan();
  await h.services.local.serial(connector.deviceId, () =>
    h.services.local.sync.reconcile(account.ownerId, connector.deviceId),
  );
  const current = (
    await h.services.local.repository.list(account.ownerId, connector.deviceId)
  ).find((r) => r.resourceId === skill.id)!;
  expect(current.skillVersionId).not.toBe(initial.skillVersionId);
  expect((await h.services.profiles.owned(account.ownerId, profile!.id)).skillVersionIds).toEqual([
    initial.skillVersionId,
  ]);
});
test('offline platform edits resume on reconnect and repeated scans do not loop', async () => {
  await connector.close();
  await vi.waitFor(() => expect(h.services.broker.online(connector.deviceId)).toBe(false));
  const row = await binding();
  await changeBinding({ content: { ...row.content, description: 'offline platform pending' } });
  expect(
    (await h.services.local.state(account.ownerId, connector.deviceId)).issues.join(' '),
  ).toContain('离线');
  await connector.restart();
  await vi.waitFor(async () => expect((await binding()).status).toBe('synced'));
  expect(await readFile(path, 'utf8')).toContain('offline platform pending');
  const revision = (await binding()).revision;
  await scan();
  await h.services.local.serial(connector.deviceId, () =>
    h.services.local.sync.reconcile(account.ownerId, connector.deviceId),
  );
  expect((await binding()).revision).toBe(revision);
  expect(mcp.count()).toBe(0);
});
test('an interrupted platform mutation resumes exactly once after connector restart', async () => {
  await connector.close();
  const row = await binding();
  const input = {
    deviceId: connector.deviceId,
    id: row.id,
    revision: row.revision,
    operationId: randomUUID(),
    action: 'update' as const,
    content: { ...row.content, description: 'recovered pending edit' },
  };
  const operation = await h.services.local.repository.operation(account.ownerId, {
    deviceId: connector.deviceId,
    key: input.operationId,
    action: input.action,
    payload: input,
  });
  await connector.restart();
  await vi.waitFor(async () => expect((await binding()).status).toBe('synced'));
  await vi.waitFor(async () =>
    expect(
      (
        await h.services.local.repository.existingOperation(
          account.ownerId,
          connector.deviceId,
          input.operationId,
        )
      )?.phase,
    ).toBe('succeeded'),
  );
  await vi.waitFor(async () => {
    expect((await binding()).status).toBe('synced');
    expect(await readFile(path, 'utf8')).toContain('recovered pending edit');
  });
  const repeated = await h.services.local.mutateBinding(account.ownerId, input);
  expect((repeated as { content: unknown }).content).toEqual(input.content);
  expect((await h.services.connections.list(account.ownerId)).length).toBe(1);
  expect(operation.phase).toBe('pending');
});
test('unlink keeps local Skill files and every immutable platform version', async () => {
  const skill = (await h.services.local.repository.list(account.ownerId, connector.deviceId)).find(
    (row) => row.metadata.kind === 'skill',
  )!;
  const before = await readFile(
    join(h.directory, '.agents', 'skills', 'local-example', 'SKILL.md'),
    'utf8',
  );
  const versions = await h.services.skills.list(account.ownerId);
  await h.services.local.mutateBinding(account.ownerId, {
    deviceId: connector.deviceId,
    id: skill.id,
    revision: skill.revision,
    operationId: randomUUID(),
    action: 'unlink',
  });
  expect(
    await readFile(join(h.directory, '.agents', 'skills', 'local-example', 'SKILL.md'), 'utf8'),
  ).toBe(before);
  expect(await h.services.skills.list(account.ownerId)).toEqual(versions);
  expect((await state()).resources[skill.resourceId]?.selected).toBe(false);
});
test('deletion waits for confirmation and retains immutable platform history', async () => {
  await changeBinding({ action: 'delete' });
  expect((await binding()).status).toBe('deletion_pending');
  expect(await readFile(path, 'utf8')).toContain('recovered pending edit');
  await changeBinding({ action: 'delete', confirm: true });
  expect((await binding()).status).toBe('deleted');
  expect(await readFile(path, 'utf8')).not.toContain('recovered pending edit');
  const row = await binding();
  expect((await h.services.connections.owned(account.ownerId, row.connectionId!)).status).toBe(
    'stopped',
  );
  const oldVersion = await h.services.skills.list(account.ownerId);
  expect(oldVersion.length).toBe(2);
  const conn = await h.db.select().from(connections).where(eq(connections.id, row.connectionId!));
  expect(conn.length).toBe(1);
});

test('rejected plaintext platform credentials are never persisted to operation records', async () => {
  const row = await binding();
  await expect(
    changeBinding({
      action: 'update',
      content: { ...row.content, headers: { Authorization: 'accidental-plaintext-secret' } },
    }),
  ).rejects.toThrow('本机管理页');
  const ops = await h.services.local.repository.operations(account.ownerId, connector.deviceId);
  expect(JSON.stringify(ops)).not.toContain('accidental-plaintext-secret');
});
