import { expect, test } from 'vitest';
import { compileBundle, mcpbManifest } from '../packages/contracts/src/mcpb.js';
import { manifest } from './fixtureBundle.js';

test.each(['darwin', 'linux', 'win32'] as const)(
  'parsed %s overrides inherit omitted arguments through persistence',
  (platform) => {
    for (const override of [{ command: 'custom-node' }, { env: { EXTRA: 'value' } }]) {
      const source = manifest();
      const parsed = mcpbManifest.parse({
        ...source,
        server: {
          ...source.server,
          mcp_config: { ...source.server.mcp_config, platform_overrides: { [platform]: override } },
        },
      });
      const persisted = mcpbManifest.parse(JSON.parse(JSON.stringify(parsed)));
      expect(persisted.server.mcp_config.platform_overrides?.[platform]).not.toHaveProperty('args');
      expect(
        compileBundle({
          manifest: persisted,
          environment: { platform, home: '/home/test', root: '/bundles/test' },
          values: { key: 'test-value' },
        }),
      ).toMatchObject({
        command: override.command ?? source.server.mcp_config.command,
        args: ['/bundles/test/server.cjs'],
        env: { PRIVATE: 'test-value', ...override.env },
      });
    }
  },
);

test('platform overrides can explicitly clear or replace arguments', () => {
  for (const args of [[], ['other.cjs']]) {
    const source = manifest();
    const parsed = mcpbManifest.parse({
      ...source,
      server: {
        ...source.server,
        mcp_config: { ...source.server.mcp_config, platform_overrides: { linux: { args } } },
      },
    });
    expect(
      compileBundle({
        manifest: parsed,
        environment: { platform: 'linux', home: '/home/test', root: '/bundles/test' },
        values: { key: 'test-value' },
      }).args,
    ).toEqual(args);
  }
});
