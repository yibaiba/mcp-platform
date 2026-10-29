import { expect, test } from 'vitest';
import { createServer } from 'node:http';
import { npmAuthorization } from '../packages/network/src/npmConfig.js';
import { queryPackage } from '../apps/server/src/modules/updates/packageVersions.js';

const basic = Buffer.from('fixture-user:fixture-password').toString('base64');
const password = Buffer.from('fixture-password').toString('base64');

const parentCredentials: Record<string, string>[] = [
  { '//registry.test/:_auth': basic },
  { '//registry.test/:username': 'fixture-user', '//registry.test/:_password': password },
];
test.each(parentCredentials)(
  'Basic credentials cover child paths without crossing host/path boundaries',
  (credentials) => {
    expect(npmAuthorization('https://registry.test/npm/private/', credentials)).toEqual({
      Authorization: `Basic ${basic}`,
    });
    expect(npmAuthorization('https://other.test/npm/', credentials)).toEqual({});
    expect(npmAuthorization('https://registry.test:8443/npm/', credentials)).toEqual({});
    expect(
      npmAuthorization('https://registry.test/npm-evil/', { '//registry.test/npm/:_auth': basic }),
    ).toEqual({});
  },
);

test('the most specific complete credential wins, with token precedence at the same scope', () => {
  const credentials = {
    '//registry.test/:_authToken': 'root-token',
    '//registry.test/npm/:_auth': basic,
  };
  expect(npmAuthorization('https://registry.test/npm/private/', credentials)).toEqual({
    Authorization: `Basic ${basic}`,
  });
  expect(
    npmAuthorization('https://registry.test/npm/private/', {
      ...credentials,
      '//registry.test/npm/:_authToken': 'scoped-token',
    }),
  ).toEqual({ Authorization: 'Bearer scoped-token' });
});

test('package metadata requests send parent-scoped Basic authentication to the private registry', async () => {
  const seen: { path?: string; auth?: string }[] = [];
  const server = createServer((request, response) => {
    seen.push({ path: request.url, auth: request.headers.authorization });
    response.setHeader('Content-Type', 'application/json');
    if (request.headers.authorization !== `Basic ${basic}`) {
      response.writeHead(401).end('{}');
      return;
    }
    response.end(JSON.stringify({ versions: { '1.0.0': {} } }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const host = `127.0.0.1:${(server.address() as { port: number }).port}`;
  const spec = {
    ecosystem: 'npm' as const,
    name: 'fixture',
    configured: '1.0.0',
    source: `http://${host}/npm/`,
  };
  try {
    await expect(
      queryPackage(spec, fetch, npmAuthorization(spec.source, { [`//${host}/:_auth`]: basic })),
    ).resolves.toEqual(['1.0.0']);
    expect(seen).toEqual([{ path: '/npm/fixture', auth: `Basic ${basic}` }]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
