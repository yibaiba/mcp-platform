import { afterAll, beforeAll, expect, test } from 'vitest';
import { harness } from './harness.js';
import { fixtureMcp } from './fixtureMcp.js';
import {
  mergeTextOptions,
  mergeToolOptions,
} from '../apps/server/src/modules/configuration/catalogOverrides.js';

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
const ref = { connection: 'echo', name: 'echo' };
function declaration() {
  return {
    version: 1,
    name: 'regression',
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
    profiles: { agent: { name: 'Agent', tools: [ref] } },
  };
}

test.each([false, true])(
  'overlapping manifest references preserve hidden arguments with reversed=%s',
  async (reversed) => {
    const owner = await h.signup();
    const restricted = { ...ref, alias: 'safe_echo', hiddenParameters: ['delay'] };
    const base = declaration();
    const value = {
      ...base,
      profiles: {
        agent: {
          name: 'Agent',
          tools: reversed ? [ref, ref] : [restricted, ref],
          requestable: { tools: reversed ? [restricted] : [ref] },
        },
      },
    };
    const manifest = await h.services.manifests.apply(owner.ownerId, { declaration: value });
    expect(manifest.status).toBe('ready');
    const profileId = manifest.entries.find((entry) => entry.kind === 'profile')!.objectId!;
    const profile = await h.services.profiles.owned(owner.ownerId, profileId);
    const toolId = profile.toolIds[0]!;
    expect(profile.catalog.tools[toolId]).toMatchObject({
      alias: 'safe_echo',
      hiddenParameters: ['delay'],
    });
    const invoke = (args: Record<string, unknown>) =>
      h.services.invocations.call({
        ownerId: owner.ownerId,
        profileId,
        toolId,
        arguments: args,
      });
    const before = upstream.count();
    await expect(invoke({ message: 'denied', delay: 0 })).rejects.toMatchObject({
      code: 'HIDDEN_PARAMETER',
    });
    expect(upstream.count()).toBe(before);
    await expect(invoke({ message: 'allowed' })).resolves.toBeDefined();
    expect(upstream.count()).toBe(before + 1);
  },
);

test('repeated overrides merge restrictions and reject conflicting display metadata', () => {
  expect(
    mergeToolOptions({ hiddenParameters: ['first'] }, { hiddenParameters: ['second', 'first'] }),
  ).toEqual({ hiddenParameters: ['first', 'second'] });
  expect(() =>
    mergeToolOptions(
      { alias: 'one', hiddenParameters: [] },
      { alias: 'two', hiddenParameters: [] },
    ),
  ).toThrow('alias');
  expect(mergeTextOptions({ description: 'keep' }, {})).toEqual({ description: 'keep' });
  expect(() => mergeTextOptions({ description: 'one' }, { description: 'two' })).toThrow(
    'description',
  );
});

test('pending exports fail explicitly and never substitute old permissions or omit uncreated connections', async () => {
  const owner = await h.signup();
  const base = declaration();
  await h.services.manifests.apply(owner.ownerId, { declaration: base });
  expect((await owner.request('/config/export')).status).toBe(200);
  const desired = {
    ...base,
    profiles: { agent: { name: 'Agent', tools: [{ ...ref, name: 'undiscovered' }] } },
  };
  expect((await h.services.manifests.apply(owner.ownerId, { declaration: desired })).status).toBe(
    'pending',
  );
  await expect(h.services.configExport.export(owner.ownerId, 'copy')).rejects.toMatchObject({
    code: 'DEPLOYMENT_PENDING',
  });
  expect((await owner.request('/config/export')).status).toBe(409);
  expect(
    (await h.services.manifests.status(owner.ownerId, base.name)).declaration.profiles.agent!
      .tools[0]!.name,
  ).toBe('undiscovered');
  await h.services.manifests.apply(owner.ownerId, { declaration: base });
  expect(
    (await h.services.configExport.export(owner.ownerId, 'copy')).profiles.Agent!.tools[0]!.name,
  ).toBe('echo');
  const missing = await h.signup();
  await h.services.manifests.apply(missing.ownerId, {
    declaration: {
      ...base,
      profiles: {},
      connections: {
        echo: {
          config: {
            ...base.connections.echo.config,
            headers: { Authorization: { secretRef: 'missing' } },
          },
        },
      },
    },
  });
  await expect(h.services.configExport.export(missing.ownerId, 'copy')).rejects.toMatchObject({
    code: 'DEPLOYMENT_PENDING',
  });
});
