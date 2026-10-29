import { afterEach, expect, test } from 'vitest';
import { createServer, type Server } from 'node:http';
import { connect } from 'node:net';
import {
  NetworkClient,
  bypassProxy,
  githubClone,
  githubTarget,
  processNetwork,
  resolvePackage,
} from '../packages/network/src/index.js';
import { networkSettings, type NetworkConfig } from '../packages/contracts/src/index.js';
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  await Promise.all(
    cleanup
      .splice(0)
      .reverse()
      .map((close) => close()),
  );
});
const config = (settings = {}): NetworkConfig => ({
  ...networkSettings.parse(settings),
  secrets: {},
});
async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
test('NO_PROXY handles label boundaries, ports, IPv4/IPv6 and wildcard', () => {
  for (const [url, pattern, expected] of [
    ['https://api.example.com', '.example.com:443', true],
    ['http://api.example.com', '.example.com:443', false],
    ['https://notexample.com', 'example.com', false],
    ['http://127.0.0.1:123', '127.0.0.1:123', true],
    ['http://[::1]:123', '[::1]:123', true],
    ['http://[::1]:123', '::1', true],
    ['https://example.org', '*', true],
  ] as const)
    expect(bypassProxy(new URL(url), pattern)).toBe(expected);
});
test('authenticated CONNECT proxy is used, NO_PROXY bypasses it and proxy failure never falls back', async () => {
  let hits = 0,
    tunnels = 0;
  const origin = await listen(
    createServer((_req, res) => {
      hits++;
      res.end('origin');
    }),
  );
  const proxy = createServer();
  proxy.on('connect', (req, socket, head) => {
    tunnels++;
    expect(req.headers['proxy-authorization']).toBe(
      `Basic ${Buffer.from('user:pass').toString('base64')}`,
    );
    const target = new URL(`http://${req.url}`);
    const upstream = connect(Number(target.port), target.hostname, () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    socket.on('error', () => upstream.destroy());
    upstream.on('error', () => socket.destroy());
  });
  const proxyUrl = await listen(proxy);
  const client = new NetworkClient({
    ...config({ httpProxy: proxyUrl }),
    secrets: { httpProxyAuth: 'user:pass' },
  });
  cleanup.push(() => client.close());
  expect(await (await client.fetch(origin)).text()).toBe('origin');
  expect(tunnels).toBe(1);
  const bypass = new NetworkClient(config({ httpProxy: proxyUrl, noProxy: '127.0.0.1' }));
  cleanup.push(() => bypass.close());
  expect(await (await bypass.fetch(origin)).text()).toBe('origin');
  expect(tunnels).toBe(1);
  const broken = new NetworkClient(config({ httpProxy: 'http://127.0.0.1:1' }));
  cleanup.push(() => broken.close());
  await expect(broken.fetch(origin)).rejects.toThrow();
  expect(hits).toBe(2);
});
test('public source replacement, private declarations, explicit source and execution agree', () => {
  const settings = config({
    npmRegistry: 'https://mirror.test/',
    pythonIndex: 'https://python.test/simple/',
    replacePublicSources: true,
  });
  const npm = {
    command: 'npx',
    args: ['--registry', 'https://registry.npmjs.org/', '-y', '@scope/pkg@1.0.0'],
  };
  expect(resolvePackage(npm, settings)?.source).toBe('https://mirror.test/');
  expect(processNetwork(npm, settings).args).toContain('https://mirror.test/');
  expect(
    resolvePackage({ ...npm, args: ['--registry=https://private.test/', 'pkg@1'] }, settings)
      ?.source,
  ).toBe('https://private.test/');
  expect(
    resolvePackage({ ...npm, packageSource: 'https://explicit.test/' }, settings)?.source,
  ).toBe('https://explicit.test/');
  expect(
    resolvePackage(
      { command: 'uv', args: ['tool', 'run', '--from', 'my-pkg==1.0', 'my-pkg'] },
      settings,
    ),
  ).toMatchObject({
    ecosystem: 'pypi',
    source: 'https://python.test/simple/',
    configured: '==1.0',
  });
});
test('GitHub templates preserve original path/query and fixed repository; unknown hosts are untouched', () => {
  const settings = config({
    githubApi: 'https://api.test/prefix',
    githubDownload: 'https://download.test/{encodedUrl}',
    githubClone: 'https://git.test/{owner}/{repo}.git',
  });
  const original = new URL('https://github.com/o/r/archive/0123456789abcdef.zip?download=1');
  expect(decodeURIComponent(githubTarget(original, settings).url.pathname.slice(1))).toBe(
    original.href,
  );
  expect(
    githubTarget(new URL('https://api.github.com/repos/o/r/releases?page=2'), settings).url.href,
  ).toBe('https://api.test/prefix/repos/o/r/releases?page=2');
  expect(githubClone('https://github.com/o/r.git', settings)).toBe('https://git.test/o/r.git');
  expect(githubTarget(new URL('https://github.com.evil.test/o/r'), settings).url.hostname).toBe(
    'github.com.evil.test',
  );
  expect(() => networkSettings.parse({ githubDownload: 'https://{url}/' })).toThrow();
});
test('rewrite and cross-origin redirect do not forward original or custom endpoint credentials', async () => {
  let headers: Record<string, string | string[] | undefined> = {};
  const destination = await listen(
    createServer((req, res) => {
      headers = req.headers;
      res.end('ok');
    }),
  );
  let mirrorAuth: string | undefined;
  const mirror = await listen(
    createServer((req, res) => {
      mirrorAuth = req.headers.authorization;
      expect(req.headers.cookie).toBeUndefined();
      expect(req.headers['x-api-key']).toBeUndefined();
      res.writeHead(302, { location: destination });
      res.end();
    }),
  );
  const client = new NetworkClient({
    ...config({ githubApi: mirror }),
    secrets: { githubApiToken: 'mirror-token' },
  });
  cleanup.push(() => client.close());
  expect(
    await (
      await client.fetch('https://api.github.com/repos/o/r', {
        headers: {
          authorization: 'original-token',
          cookie: 'session=secret',
          'x-api-key': 'private',
        },
      })
    ).text(),
  ).toBe('ok');
  expect(mirrorAuth).toBe('Bearer mirror-token');
  expect(headers.authorization).toBeUndefined();
  expect(headers.cookie).toBeUndefined();
});
