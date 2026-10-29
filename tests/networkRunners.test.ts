import { expect, test } from 'vitest';
import { networkSettings } from '../packages/contracts/src/network.js';
import { identifyPackage, processNetwork, resolvePackage } from '../packages/network/src/index.js';

const config = { ...networkSettings.parse({ npmRegistry: 'https://mirror.test/' }), secrets: {} };

test.each([
  ['pkg@1.0.0', '--registry', 'https://private.test/'],
  ['pkg@1.0.0', '--registry=https://private.test/'],
  ['pkg@1.0.0', '--registry=https://old.test/', '--registry=https://private.test/'],
  ['--package=pkg@1.0.0', 'command', '--registry=https://private.test/'],
  ['pkg@1.0.0', '--registry=https://private.test/', '--', 'tool-argument'],
])('npm exec parses trailing source options: %j', (...args) => {
  const input = { command: 'npm', args: ['exec', ...args] };
  expect(resolvePackage(input, config)).toMatchObject({
    name: 'pkg',
    source: 'https://private.test/',
  });
  const overridden = processNetwork({ ...input, packageSource: 'https://override.test/' }, config);
  expect(resolvePackage({ command: 'npm', args: overridden.args }, config)?.source).toBe(
    'https://override.test/',
  );
});

test.each([
  { command: 'npm', args: ['exec', '--', 'pkg@1.0.0', '--registry', 'https://tool.test/'] },
  { command: 'npm', args: ['exec', 'pkg@1.0.0', '--', '--registry', 'https://tool.test/'] },
  { command: 'npx', args: ['pkg@1.0.0', '--registry', 'https://tool.test/'] },
])('tool arguments remain untouched for $command $args', (input) => {
  const prepared = processNetwork(input, config);
  expect(prepared.package).toMatchObject({ name: 'pkg', source: 'https://mirror.test/' });
  expect(prepared.args.slice(-2)).toEqual(['--registry', 'https://tool.test/']);
});

test('npm exec rejects multiple package declarations after the command as ambiguous', () => {
  expect(
    identifyPackage({
      command: 'npm',
      args: ['exec', '--package=first', 'command', '--package=second'],
    }),
  ).toBeUndefined();
});
