import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { connectionShares } from '../packages/db/src/index.js';
import { ManifestStore } from '../apps/server/src/modules/configuration/manifestStore.js';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { harness } from './harness.js';
import { fixtureMcp } from './fixtureMcp.js';
let h: Awaited<ReturnType<typeof harness>>;
let upstream: Awaited<ReturnType<typeof fixtureMcp>>;
beforeAll(async () => {
  h = await harness();
  upstream = await fixtureMcp();
});
afterAll(async () => {
  await h?.close();
  await upstream?.close();
});
function declaration() {
  return {
    version: 1,
    name: 'deployment',
    connections: {
      echo: {
        config: {
          name: 'Echo',
          adapter: 'direct',
          transport: 'http',
          mode: 'existing',
          url: upstream.url,
        },
      },
    },
    profiles: {
      agent: {
        name: 'Agent',
        tools: [
          { connection: 'echo', name: 'echo', alias: 'public_echo', hiddenParameters: ['delay'] },
        ],
      },
    },
  };
}
test('one declaration discovers real capabilities, is idempotent and exports logical references without database IDs or secrets', async () => {
  const { ownerId } = await h.signup();
  const value = declaration();
  const input = { declaration: value };
  const first = await h.services.manifests.apply(ownerId, input);
  expect(first.status).toBe('ready');
  const profileId = first.entries.find((entry) => entry.kind === 'profile')!.objectId!;
  const profile = await h.services.profiles.owned(ownerId, profileId);
  expect(profile.deploymentState).toBe('ready');
  const catalog = await h.services.profiles.catalog(ownerId, profileId);
  expect(catalog[0]!.exposedName).toBe('public_echo');
  const key = await h.services.profiles.issue(ownerId, profileId);
  const again = await h.services.manifests.apply(ownerId, input);
  expect(again.revision).toBe(first.revision);
  expect(again.entries.map((entry) => [entry.objectId, entry.revision])).toEqual(
    first.entries.map((entry) => [entry.objectId, entry.revision]),
  );
  expect(await h.services.profiles.authenticate(profileId, key.token)).toMatchObject({ ownerId });
  const exported = await h.services.configExport.export(ownerId, 'portable');
  expect(exported.profiles.Agent!.tools[0]).toMatchObject({
    connection: 'Echo',
    name: 'echo',
    alias: 'public_echo',
    hiddenParameters: ['delay'],
  });
  const text = JSON.stringify(exported);
  for (const entry of first.entries) expect(text).not.toContain(entry.objectId);
  expect(text).not.toContain(key.token);
  const other = await h.signup();
  expect((await h.services.manifests.apply(other.ownerId, { declaration: exported })).status).toBe(
    'ready',
  );
});
test('a missing secret saves the whole declaration and automatically resolves after its owner configures it', async () => {
  const { ownerId } = await h.signup();
  const value = declaration();
  const input = {
    declaration: {
      ...value,
      connections: {
        echo: {
          config: {
            ...value.connections.echo.config,
            headers: { 'X-Api-Key': { secretRef: 'echo-key' } },
          },
        },
      },
    },
  };
  const pending = await h.services.manifests.apply(ownerId, input);
  expect(pending.status).toBe('pending');
  expect(pending.declaration.profiles.agent!.tools).toHaveLength(1);
  const profileId = pending.entries.find((entry) => entry.kind === 'profile')!.objectId!;
  const key = await h.services.profiles.issue(ownerId, profileId);
  await expect(h.services.profiles.authenticate(profileId, key.token)).rejects.toMatchObject({
    code: 'DEPLOYMENT_PENDING',
  });
  const other = await h.signup();
  await h.services.secrets.save(other.ownerId, { name: 'echo-key', value: 'other-private-value' });
  expect((await h.services.manifests.refresh(ownerId))[0]!.status).toBe('pending');
  await h.services.secrets.save(ownerId, { name: 'echo-key', value: 'private-value' });
  expect((await h.services.manifests.status(ownerId, 'deployment')).status).toBe('ready');
  const exported = JSON.stringify(await h.services.configExport.export(ownerId, 'safe'));
  expect(exported).not.toContain('private-value');
  expect(exported).toContain('secretRef');
});
test('updated unresolved declarations block previous grants, and prune removes only managed objects', async () => {
  const { ownerId } = await h.signup();
  const value = declaration();
  const first = await h.services.manifests.apply(ownerId, { declaration: value });
  const profileId = first.entries.find((entry) => entry.kind === 'profile')!.objectId!;
  const key = await h.services.profiles.issue(ownerId, profileId);
  const missing = {
    ...value,
    profiles: { agent: { name: 'Agent', tools: [{ connection: 'echo', name: 'not-discovered' }] } },
  };
  expect((await h.services.manifests.apply(ownerId, { declaration: missing })).status).toBe(
    'pending',
  );
  await expect(h.services.profiles.authenticate(profileId, key.token)).rejects.toMatchObject({
    code: 'DEPLOYMENT_PENDING',
  });
  const unmanaged = await h.services.connections.create(ownerId, {
    ...value.connections.echo.config,
    name: 'Manual',
  });
  const pruned = await h.services.manifests.apply(ownerId, {
    declaration: { version: 1, name: 'deployment' },
    mode: 'prune',
  });
  expect(pruned.entries).toEqual([]);
  expect(await h.services.connections.owned(ownerId, unmanaged.id)).toBeDefined();
  await expect(h.services.profiles.owned(ownerId, profileId)).rejects.toThrow();
});
test('manual connection edits are reported in preview and never overwritten', async () => {
  const { ownerId } = await h.signup();
  const input = { declaration: declaration() };
  const first = await h.services.manifests.apply(ownerId, input);
  const id = first.entries.find((entry) => entry.kind === 'connection')!.objectId!;
  await h.services.connections.update(ownerId, id, { name: 'Manual revision' });
  expect((await h.services.manifests.preview(ownerId, input)).conflicts).toEqual([
    'connection:echo',
  ]);
  await expect(h.services.manifests.apply(ownerId, input)).rejects.toMatchObject({
    code: 'MANIFEST_CONFLICT',
  });
  expect((await h.services.connections.owned(ownerId, id)).name).toBe('Manual revision');
});

test('declaration replacement removes omitted optional settings while an unchanged declaration preserves revisions', async () => {
  const { ownerId } = await h.signup();
  const value = declaration();
  const withOAuth = {
    ...value,
    connections: {
      echo: {
        config: { ...value.connections.echo.config, oauth: { clientId: 'old-declaration' } },
      },
    },
  };
  const first = await h.services.manifests.apply(ownerId, { declaration: withOAuth });
  expect(first.status).toBe('ready');
  const id = first.entries.find((entry) => entry.kind === 'connection')!.objectId!;
  expect((await h.services.connections.context(ownerId, id)).config.oauth).toBeDefined();
  const replaced = await h.services.manifests.apply(ownerId, { declaration: value });
  expect(replaced.status).toBe('ready');
  expect((await h.services.connections.context(ownerId, id)).config.oauth).toBeUndefined();
});
test('directory mappings remain pending until a real directory exists and invalid declarations do not persist', async () => {
  const { ownerId } = await h.signup();
  const root = await mkdtemp(join(tmpdir(), 'manifest-directory-'));
  try {
    const path = join(root, 'later');
    const value = declaration();
    const input = {
      declaration: {
        ...value,
        connections: {
          echo: { config: { ...value.connections.echo.config, cwd: { directoryRef: 'work' } } },
        },
      },
      mappings: { directories: { work: path } },
    };
    expect((await h.services.manifests.apply(ownerId, input)).status).toBe('pending');
    await mkdir(path);
    expect((await h.services.manifests.refresh(ownerId))[0]!.status).toBe('ready');
    await expect(
      h.services.manifests.apply(ownerId, {
        declaration: {
          ...value,
          name: 'invalid',
          connections: {
            echo: {
              config: {
                ...value.connections.echo.config,
                headers: { Authorization: 'inline-private-token' },
              },
            },
          },
        },
      }),
    ).rejects.toThrow();
    expect(await h.services.manifests.list(ownerId)).toHaveLength(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a failed prune checkpoint rolls back deletion and retry continues after already committed entries', async () => {
  const { ownerId } = await h.signup();
  const original = await h.services.manifests.apply(ownerId, { declaration: declaration() });
  const connectionId = original.entries.find((entry) => entry.kind === 'connection')!.objectId!;
  const removed = { declaration: { version: 1, name: 'deployment' }, mode: 'prune' };
  const checkpoint = ManifestStore.prototype.checkpoint;
  const failure = vi.spyOn(ManifestStore.prototype, 'checkpoint').mockImplementation(function (
    this: ManifestStore,
    manifest,
    entries,
    db,
  ) {
    if (manifest.mode === 'prune' && entries.length === 0 && db)
      throw new Error('Checkpoint storage failure');
    return checkpoint.call(this, manifest, entries, db);
  });
  try {
    await expect(h.services.manifests.apply(ownerId, removed)).rejects.toThrow(
      'Checkpoint storage failure',
    );
  } finally {
    failure.mockRestore();
  }
  expect((await h.services.connections.owned(ownerId, connectionId)).id).toBe(connectionId);
  expect((await h.services.manifests.status(ownerId, 'deployment')).status).toBe('pending');
  const retry = await h.services.manifests.apply(ownerId, removed);
  expect(retry.status).toBe('ready');
  expect(retry.entries).toEqual([]);
  await expect(h.services.connections.owned(ownerId, connectionId)).rejects.toMatchObject({
    code: 'NOT_FOUND',
  });
});
test('shared grant revocation and its prune checkpoint commit atomically', async () => {
  const owner = await h.signup();
  const recipient = await h.signup();
  const input = {
    declaration: {
      ...declaration(),
      profiles: {},
      shares: {
        team: {
          connection: 'echo',
          recipientRef: 'recipient',
          credentialMode: 'owner',
          tools: ['echo'],
        },
      },
    },
    mappings: { users: { recipient: recipient.ownerId } },
  };
  const original = await h.services.manifests.apply(owner.ownerId, input);
  const entry = original.entries.find((entry) => entry.kind === 'share')!;
  const checkpoint = ManifestStore.prototype.checkpoint;
  const failure = vi.spyOn(ManifestStore.prototype, 'checkpoint').mockImplementation(function (
    this: ManifestStore,
    manifest,
    entries,
    db,
  ) {
    if (manifest.mode === 'prune' && !entries.some((item) => item.kind === 'share') && db)
      throw new Error('Shared checkpoint failure');
    return checkpoint.call(this, manifest, entries, db);
  });
  const prune = {
    declaration: { ...input.declaration, shares: {} },
    mappings: input.mappings,
    mode: 'prune',
  };
  try {
    await expect(h.services.manifests.apply(owner.ownerId, prune)).rejects.toThrow(
      'Shared checkpoint failure',
    );
  } finally {
    failure.mockRestore();
  }
  const [grant] = await h.db
    .select()
    .from(connectionShares)
    .where(eq(connectionShares.id, entry.objectId!));
  expect(grant).toMatchObject({ revoked: false, version: entry.revision });
  expect((await h.services.manifests.apply(owner.ownerId, prune)).status).toBe('ready');
  const [revoked] = await h.db
    .select()
    .from(connectionShares)
    .where(eq(connectionShares.id, entry.objectId!));
  expect(revoked).toMatchObject({ revoked: true, version: entry.revision! + 1 });
});
