import { afterAll, beforeAll, expect, test } from 'vitest';
import { clientPresets } from '../packages/contracts/src/clientPresets.js';
import { harness } from './harness.js';
import { fixtureMcp } from './fixtureMcp.js';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
let h: Awaited<ReturnType<typeof harness>>;
beforeAll(async () => {
  h = await harness();
});
test('service descriptions retain metadata and append only granted services in stable order for external clients', async () => {
  const account = await h.signup();
  const upstream = await fixtureMcp({ instructions: 'Upstream usage instructions' });
  const client = new Client({ name: 'Instructions client', version: '1' });
  try {
    const connections = await Promise.all(
      ['Second', 'First', 'Unselected'].map(async (name) => {
        const connection = await h.services.connections.create(account.ownerId, {
          name,
          adapter: 'direct',
          transport: 'http',
          mode: 'existing',
          url: upstream.url,
        });
        const [tool] = await h.services.connections.discover(account.ownerId, connection.id);
        expect(
          (await h.services.connections.snapshot(account.ownerId, connection.id))?.serverInfo,
        ).toMatchObject({ name: 'integration-fixture', version: '1' });
        return { ...connection, name, toolId: tool!.id };
      }),
    );
    const selected = connections.slice(0, 2);
    const profile = (await h.services.profiles.save(account.ownerId, {
      name: 'Instructions',
      instructions: 'Profile usage instructions',
      toolIds: selected.map((row) => row.toolId),
    }))!;
    const expected = [
      'Profile usage instructions',
      ...selected
        .toSorted((a, b) => a.id.localeCompare(b.id))
        .map((row) => `[${row.name} · ${row.id}]\nUpstream usage instructions`),
    ].join('\n\n');
    expect(await h.services.profiles.instructions(account.ownerId, profile.id)).toBe(expected);
    const key = await h.services.profiles.issue(account.ownerId, profile.id);
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${h.baseURL}/mcp/${profile.id}`), {
        requestInit: { headers: { Authorization: `Bearer ${key.token}` } },
      }),
    );
    expect(client.getInstructions()).toBe(expected);
  } finally {
    await client.close();
    await upstream.close();
  }
});
afterAll(async () => {
  await h?.close();
});
test('all client presets export public URLs with placeholders; only issuance returns full credentials', async () => {
  const account = await h.signup();
  const profile = await h.services.profiles.save(account.ownerId, { name: 'Exports' });
  if (!profile) throw new Error('Profile was not saved');
  const issue = await account.request(`/profiles/${profile.id}/keys`, { method: 'POST' });
  expect(issue.status).toBe(201);
  const issued = (await issue.json()) as {
    token: string;
    exports: { preset: string; config: string }[];
  };
  expect(issued.exports.map((entry) => entry.preset)).toEqual([...clientPresets]);
  for (const preset of clientPresets) {
    const response = await account.request(`/profiles/${profile.id}/export?client=${preset}`);
    expect(response.status).toBe(200);
    const output = (await response.json()) as {
      config: string;
      credential: string;
      command?: string;
    };
    expect(output.config).toContain(`${h.baseURL}/mcp/${profile.id}`);
    expect(output.config).not.toContain(issued.token);
    expect(output.credential).toBe('placeholder');
    expect(issued.exports.find((entry) => entry.preset === preset)!.config).toContain(issued.token);
    if (preset !== 'codex') expect(() => JSON.parse(output.config)).not.toThrow();
  }
  const keys = await (await account.request('/profiles/keys/all')).text();
  expect(keys).not.toContain(issued.token);
  const stranger = await h.signup();
  expect((await stranger.request(`/profiles/${profile.id}/export?client=cursor`)).status).toBe(404);
});
