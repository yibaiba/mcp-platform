import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { libraryItem, renderPrompt } from '../packages/contracts/src/library.js';
import { harness } from './harness.js';
import { scopedUri } from '../apps/server/src/modules/mcp/catalogEntries.js';
let h: Awaited<ReturnType<typeof harness>>;
beforeAll(async () => {
  h = await harness();
});
afterAll(async () => {
  await h?.close();
});
const prompt = {
  kind: 'prompt' as const,
  name: 'brief',
  template: '主题 {{topic}} / {{extra}}',
  arguments: [{ name: 'topic', required: true }, { name: 'extra' }],
};
test('template rendering uses literal substitutions and validates declarations and arguments', () => {
  const item = libraryItem.parse(prompt);
  if (item.kind !== 'prompt') throw new Error('wrong fixture');
  expect(renderPrompt(item, { topic: '{{extra}}' })).toBe('主题 {{extra}} / ');
  expect(() => renderPrompt(item, {})).toThrow('必填');
  expect(() => renderPrompt(item, { topic: 'x', unknown: 'y' })).toThrow('未知');
  expect(() => libraryItem.parse({ ...prompt, template: '{{undeclared}}' })).toThrow();
  expect(() => libraryItem.parse({ ...prompt, template: '{{topic' })).toThrow();
});
test('owner CRUD, atomic uniqueness, revision conflict and stable identifiers', async () => {
  const account = await h.signup(),
    other = await h.signup();
  const created = await account.request('/library/prompts', {
    method: 'POST',
    body: JSON.stringify(prompt),
  });
  expect(created.status).toBe(201);
  const first = await created.json();
  expect((await other.request(`/library/prompts/${first.id}`)).status).toBe(404);
  const competing = await Promise.all(
    [1, 2].map(() =>
      account.request('/library/prompts', {
        method: 'POST',
        body: JSON.stringify({ ...prompt, name: 'same' }),
      }),
    ),
  );
  expect(competing.map((r) => r.status).sort()).toEqual([201, 409]);
  const changed = await account.request(`/library/prompts/${first.id}`, {
    method: 'PUT',
    body: JSON.stringify({ ...prompt, name: 'renamed', revision: first.revision }),
  });
  expect(changed.status).toBe(200);
  expect((await changed.json()).contentId).toBe(first.contentId);
  expect(
    (
      await account.request(`/library/prompts/${first.id}`, {
        method: 'PUT',
        body: JSON.stringify({ ...prompt, revision: first.revision }),
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await account.request(`/library/prompts/${first.id}`, {
        method: 'DELETE',
        body: JSON.stringify({ revision: first.revision }),
      })
    ).status,
  ).toBe(409);
});
test('real MCP client reads only granted local content, with disabled and deleted entries immediately unavailable', async () => {
  const { ownerId } = await h.signup();
  let item = await h.services.library.save(ownerId, { kind: 'prompt', value: prompt });
  await h.services.library.save(ownerId, {
    kind: 'prompt',
    value: { ...prompt, name: 'ungranted' },
  });
  const resource = await h.services.library.save(ownerId, {
    kind: 'resource',
    value: { name: 'guide', uri: 'resource://guide', content: '<script>raw text</script>' },
  });
  const profile = (await h.services.profiles.save(ownerId, {
    name: 'library-agent',
    contentIds: [item.contentId, resource.contentId],
  }))!;
  const key = await h.services.profiles.issue(ownerId, profile.id);
  const client = new Client(
    { name: 'library-test', version: '1' },
    { versionNegotiation: { mode: 'auto' } },
  );
  const events: string[] = [];
  client.setNotificationHandler('notifications/prompts/list_changed', () => {
    events.push('prompts');
  });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${h.baseURL}/mcp/${profile.id}`), {
      requestInit: { headers: { Authorization: `Bearer ${key.token}` } },
    }),
  );
  try {
    const prompts = await client.listPrompts();
    expect(prompts.prompts).toHaveLength(1);
    const result = await client.getPrompt({
      name: prompts.prompts[0]!.name,
      arguments: { topic: 'testing' },
    });
    expect(result.messages[0]!.content).toMatchObject({ text: '主题 testing / ' });
    const resources = await client.listResources();
    const read = await client.readResource({ uri: resources.resources[0]!.uri });
    expect(read.contents[0]).toMatchObject({ text: '<script>raw text</script>' });
    await client.listen({ promptsListChanged: true });
    item = await h.services.library.save(ownerId, {
      kind: 'prompt',
      id: item.id,
      value: { ...prompt, name: 'updated', revision: item.revision },
    });
    await vi.waitFor(() => expect(events).toContain('prompts'));
    await expect(h.services.shares.save(ownerId, item.id, {})).rejects.toThrow('跨账号');
  } finally {
    await client.close();
  }
  const access = { ownerId, profileId: profile.id };
  await h.services.library.save(ownerId, {
    kind: 'prompt',
    id: item.id,
    value: { ...prompt, revision: item.revision, enabled: false },
  });
  expect((await h.services.content.catalog(access)).some((r) => r.id === item.contentId)).toBe(
    false,
  );
  await expect(
    h.services.content.prompt({ ...access, id: item.contentId, arguments: { topic: 'x' } }),
  ).rejects.toThrow();
  await h.services.library.remove(ownerId, {
    id: resource.id,
    kind: 'resource',
    revision: resource.revision,
  });
  await expect(
    h.services.content.read({ ...access, uri: scopedUri(resource.id, 'resource://guide') }),
  ).rejects.toThrow();
});
test('configuration export/import carries logical references and content without reusing account IDs', async () => {
  const { ownerId } = await h.signup();
  const item = await h.services.library.save(ownerId, {
    kind: 'prompt',
    value: { ...prompt, name: 'review/path_提示' },
  });
  await h.services.profiles.save(ownerId, { name: 'agent', contentIds: [item.contentId] });
  const exported = await h.services.configExport.export(ownerId, 'content-template');
  expect(JSON.stringify(exported)).not.toContain(item.id);
  const other = await h.signup();
  const applied = await h.services.manifests.apply(other.ownerId, { declaration: exported });
  expect(applied.status).toBe('ready');
  const copied = await h.services.library.list(other.ownerId, 'prompt');
  expect(copied).toHaveLength(1);
  expect(copied[0]!.id).not.toBe(item.id);
  expect(copied[0]).toMatchObject({ template: prompt.template });
});

test('deletion atomically removes Profile grants and presentation references while preserving other content', async () => {
  const { ownerId } = await h.signup();
  const item = await h.services.library.save(ownerId, { kind: 'prompt', value: prompt });
  const keep = await h.services.library.save(ownerId, {
    kind: 'prompt',
    value: { ...prompt, name: 'keep' },
  });
  const profile = (await h.services.profiles.save(ownerId, {
    name: 'delete-regression',
    contentIds: [item.contentId, keep.contentId],
    requestable: { toolIds: [], contentIds: [item.contentId], artifactIds: [] },
    catalog: {
      connectionAliases: { [item.id]: 'removed', [keep.id]: 'kept' },
      content: {
        [item.contentId]: { description: 'remove' },
        [keep.contentId]: { description: 'keep' },
      },
    },
    connectionIdentities: { [item.id]: 'profile' },
  }))!;
  const unaffected = (await h.services.profiles.save(ownerId, {
    name: 'unaffected',
    contentIds: [keep.contentId],
  }))!;
  await h.services.library.remove(ownerId, {
    id: item.id,
    kind: 'prompt',
    revision: item.revision,
  });
  const updated = await h.services.profiles.owned(ownerId, profile.id);
  expect(updated.contentIds).toEqual([keep.contentId]);
  expect(updated.requestable.contentIds).toEqual([]);
  expect(updated.catalog.connectionAliases).toEqual({ [keep.id]: 'kept' });
  expect(updated.catalog.content).toEqual({ [keep.contentId]: { description: 'keep' } });
  expect(updated.connectionIdentities).toEqual({});
  expect(updated.revision).toBe(profile.revision + 1);
  expect((await h.services.profiles.owned(ownerId, unaffected.id)).revision).toBe(
    unaffected.revision,
  );
  await expect(h.services.configExport.export(ownerId, 'after-delete')).resolves.toBeDefined();
  await expect(
    h.services.profiles.save(
      ownerId,
      {
        name: updated.name,
        contentIds: updated.contentIds,
        revision: updated.revision,
        instructions: 'can still edit',
      },
      updated.id,
    ),
  ).resolves.toMatchObject({ instructions: 'can still edit' });
  await expect(
    h.services.profiles.save(
      ownerId,
      {
        name: 'stale',
        contentIds: [item.contentId],
        revision: profile.revision,
      },
      profile.id,
    ),
  ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
});
test('concurrent grant creation and content deletion never leave a dangling reference', async () => {
  const { ownerId } = await h.signup();
  const item = await h.services.library.save(ownerId, { kind: 'prompt', value: prompt });
  const results = await Promise.allSettled([
    h.services.profiles.save(ownerId, { name: 'racing', contentIds: [item.contentId] }),
    h.services.library.remove(ownerId, { id: item.id, kind: 'prompt', revision: item.revision }),
  ]);
  expect(results[1]!.status).toBe('fulfilled');
  if (results[0]!.status === 'rejected') expect(results[0]!.reason.code).toBe('INVALID_GRANTS');
  for (const profile of await h.services.profiles.list(ownerId))
    expect(profile.contentIds).not.toContain(item.contentId);
});
