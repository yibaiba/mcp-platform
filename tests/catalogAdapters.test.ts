import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { harness } from './harness.js';
import { fixtureCatalog } from './fixtureCatalog.js';
import { scopedUri } from '../apps/server/src/modules/mcp/catalogEntries.js';

let h: Awaited<ReturnType<typeof harness>>;
let fixture: Awaited<ReturnType<typeof fixtureCatalog>>;
let account: Awaited<ReturnType<typeof h.signup>>;
let child: ChildProcess;
let deviceId: string;
beforeAll(async () => {
  h = await harness();
  fixture = await fixtureCatalog();
  account = await h.signup();
  const pair = await h.services.devices.createPairing(account.ownerId, 'catalog connector');
  const device = await h.services.devices.pair(pair.code);
  deviceId = device.deviceId;
  const root = join(h.directory, 'device');
  await mkdir(root);
  const config = join(root, 'connector.json');
  await writeFile(
    config,
    JSON.stringify({
      server: h.baseURL,
      deviceId,
      deviceSecret: device.deviceSecret,
      credentialVersion: device.credentialVersion,
      skillRoots: { claude: join(root, 'skills') },
      artifactRoots: { workspace: root },
    }),
    { mode: 0o600 },
  );
  child = spawn(resolve('connector/bin/connector'), ['run', '--config', config], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr?.on('data', (data: Buffer) => process.stderr.write(data));
  await vi.waitFor(() => expect(h.services.broker.online(deviceId)).toBe(true), { timeout: 5000 });
});
afterAll(async () => {
  await h?.close();
  if (child && child.exitCode === null) {
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    child.kill('SIGINT');
    await exited;
  }
  await fixture?.close();
});

test.each(['device', 'pi'] as const)(
  '%s exposes prompts, resources, templates, metadata, progress and notifications without a model',
  async (adapter) => {
    expect(h.config.PI_ENABLED).toBe('false');
    expect(h.config.PI_MODEL_PROVIDER).toBeUndefined();
    const created = await h.services.connections.create(account.ownerId, {
      name: `${adapter} catalog`,
      adapter,
      deviceId: adapter === 'device' ? deviceId : undefined,
      transport: 'http',
      mode: 'existing',
      url: fixture.url,
    });
    const [tool] = await h.services.connections.discover(account.ownerId, created.id);
    expect(tool).toMatchObject({
      annotations: { readOnlyHint: true },
      _meta: { fixture: 'preserved' },
      outputSchema: { required: ['message'] },
    });
    const entries = (await h.services.content.catalog({ ownerId: account.ownerId })).filter(
      (entry) => entry.connectionId === created.id,
    );
    expect(entries).toHaveLength(5);
    const profile = (await h.services.profiles.save(account.ownerId, {
      name: `${adapter} content`,
      toolIds: [tool!.id],
      contentIds: entries.map((entry) => entry.id),
    }))!;
    const key = await h.services.profiles.issue(account.ownerId, profile.id);
    const client = new Client(
      { name: `${adapter}-consumer`, version: '1' },
      { versionNegotiation: { mode: 'auto' } },
    );
    const events: string[] = [];
    client.setNotificationHandler('notifications/resources/updated', (event) => {
      events.push(event.params.uri);
    });
    client.setNotificationHandler('notifications/prompts/list_changed', () => {
      events.push('prompts');
    });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${h.baseURL}/mcp/${profile.id}`), {
        requestInit: { headers: { Authorization: `Bearer ${key.token}` } },
      }),
    );
    try {
      const prompt = entries.find((entry) => entry.name === 'review')!;
      expect(
        (await client.getPrompt({ name: prompt.id, arguments: { subject: adapter } })).messages[0]
          ?.content,
      ).toMatchObject({ text: `review:${adapter}` });
      const uri = scopedUri(created.id, 'file:///shared.txt');
      expect((await client.readResource({ uri })).contents[0]?.uri).toBe(uri);
      expect(
        (await client.readResource({ uri: scopedUri(created.id, 'note:///device-note') }))
          .contents[0]?.uri,
      ).toContain('note:///device-note');
      const progress: number[] = [];
      const before = fixture.calls();
      const releaseResult = fixture.holdNextToolResult();
      // Notifications have their own receive queue; verify progress while the call is pending.
      await Promise.all([
        expect(
          client.callTool(
            { name: tool!.id, arguments: { message: adapter } },
            { onprogress: (event) => progress.push(event.progress) },
          ),
        ).resolves.toMatchObject({
          structuredContent: { message: adapter },
          _meta: { fixture: 'raw result' },
        }),
        vi.waitFor(() => expect(progress).toEqual([1]), { timeout: 5000 }).finally(releaseResult),
      ]);
      expect(fixture.calls()).toBe(before + 1);
      expect(progress).toEqual([1]);
      const listen = await client.listen({
        resourceSubscriptions: [uri],
        promptsListChanged: true,
      });
      const sessionsBeforeNotifications = h.services.connections.sessions(
        account.ownerId,
        {},
      ).length;
      await fixture.update(adapter);
      await vi.waitFor(() => expect(events).toContain(uri), { timeout: 5000 });
      await fixture.changed('prompts');
      await vi.waitFor(() => expect(events).toContain('prompts'), { timeout: 5000 });
      expect(h.services.connections.sessions(account.ownerId, {})).toHaveLength(
        sessionsBeforeNotifications,
      );
      await listen.close();
    } finally {
      await client.close();
    }
  },
  // This scenario initializes separate owner and gateway Pi workers before protocol assertions.
  30_000,
);
