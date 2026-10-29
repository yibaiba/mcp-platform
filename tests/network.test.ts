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
    ['http://[::1]', '0:0:0:0:0:0:0:1', true],
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

test('scoped npm credentials stay on their private registry; official scoped sources can opt into mirrors', async () => {
  const { npmDeclaration, npmAuthorization } = await import('../packages/network/src/npmConfig.js');
  const files = {
    home: '/home/test',
    cwd: '/work',
    read: async (path: string) =>
      path === '/home/test/.npmrc'
        ? '@team:registry=https://private.test/npm/\n//private.test/npm/:_authToken=private-fixture-token\nregistry=https://registry.npmjs.org/'
        : undefined,
  };
  const declaration = await npmDeclaration({ command: 'npx', args: ['@team/pkg@1.0.0'] }, files);
  const settings = config({ npmRegistry: 'https://mirror.test/', replacePublicSources: true });
  const resolved = resolvePackage(declaration.input, settings)!;
  expect(resolved.source).toBe('https://private.test/npm/');
  expect(processNetwork(declaration.input, settings).args).toContain(
    '--@team:registry=https://private.test/npm/',
  );
  expect(npmAuthorization(resolved.source, declaration.auth)).toEqual({
    Authorization: 'Bearer private-fixture-token',
  });
  expect(npmAuthorization('https://mirror.test/', declaration.auth)).toEqual({});
  expect(
    npmAuthorization('https://private.test/npm-evil/', {
      '//private.test/npm:_authToken': 'fixture-token',
    }),
  ).toEqual({});
  expect(
    resolvePackage(
      { ...declaration.input, sourceProtected: false, scopedSource: 'https://registry.npmjs.org/' },
      settings,
    )?.source,
  ).toBe('https://mirror.test/');
});
test('uv user default index is preserved and multiple indexes do not invent a single source', async () => {
  const { pythonDeclaration } = await import('../packages/network/src/pythonConfig.js');
  const files = {
    home: '/home/test',
    read: async (path: string) =>
      path === '/home/test/.config/uv/uv.toml'
        ? '[[index]]\nurl="https://private.test/simple/"\ndefault=true'
        : undefined,
  };
  const input = { command: 'uvx', args: ['--from', 'pkg==1.0', 'pkg'] };
  const declared = await pythonDeclaration(input, files);
  expect(
    resolvePackage(
      declared,
      config({ pythonIndex: 'https://mirror.test/simple/', replacePublicSources: true }),
    )?.source,
  ).toBe('https://private.test/simple/');
  const multiple = await pythonDeclaration(input, {
    ...files,
    read: async () => '[[index]]\nurl="https://private.test/simple/"',
  });
  expect(resolvePackage(multiple, config())).toBeUndefined();
  expect(
    processNetwork(multiple, config({ pythonIndex: 'https://mirror.test/simple/' })).args,
  ).toEqual(input.args);
});

test('scoped CLI registry outranks general CLI and file registry, while explicit connection source wins', () => {
  const input = {
    command: 'npx',
    args: [
      '--@team:registry=https://private.test/',
      '--registry',
      'https://registry.npmjs.org/',
      '@team/pkg@1.0.0',
    ],
    scopedSource: 'https://file.test/',
  };
  const settings = config({ npmRegistry: 'https://mirror.test/', replacePublicSources: true });
  expect(resolvePackage(input, settings)?.source).toBe('https://private.test/');
  const prepared = processNetwork({ ...input, packageSource: 'https://explicit.test/' }, settings);
  expect(prepared.args).toContain('--@team:registry=https://explicit.test/');
  expect(prepared.args.some((arg) => arg.includes('private.test'))).toBe(false);
});
test('rotation drains existing streams and shutdown releases unconsumed streams', async () => {
  const origin = await listen(
    createServer((_req, res) => {
      res.writeHead(200);
      res.write('open');
    }),
  );
  const client = new NetworkClient(config());
  const response = await client.fetch(origin);
  let retired = false;
  const draining = client.retire().then(() => {
    retired = true;
  });
  expect(retired).toBe(false);
  await client.close();
  await draining;
  expect(retired).toBe(true);
  await expect(response.text()).rejects.toThrow();
});
test('URL-carried credentials are rejected before a GitHub acceleration request', () => {
  const settings = config({ githubDownload: 'https://accelerator.test/{encodedUrl}' });
  expect(() =>
    githubTarget(
      new URL('https://github.com/team/repo/archive/fixed.zip?access_token=private'),
      settings,
    ),
  ).toThrow();
});

test('GitHub download acceleration does not rewrite OAuth or non-download pages', async () => {
  const settings = config({
    githubDownload: 'https://accelerator.test/{encodedUrl}',
    githubApi: 'https://api-accelerator.test',
  });
  const oauth = 'https://github.com/login/oauth/access_token';
  expect(githubTarget(new URL(oauth), settings).url.href).toBe(oauth);
  const seen: Request[] = [];
  const request: typeof fetch = async (input, init) => {
    seen.push(new Request(input, init));
    return new Response('ok');
  };
  const client = new NetworkClient(settings, request);
  try {
    await client.fetch('https://api.github.com/submission', {
      method: 'POST',
      body: 'client_secret=fixture',
      headers: { Authorization: 'Bearer fixture' },
    });
    expect(seen[0]!.url).toBe('https://api.github.com/submission');
    expect(await seen[0]!.text()).toBe('client_secret=fixture');
  } finally {
    await client.close();
  }
});

test('GitHub OAuth POST redirects cannot replay submitted credentials across origins', async () => {
  let calls = 0;
  const request: typeof fetch = async () => {
    calls++;
    return new Response(null, {
      status: 307,
      headers: { Location: 'https://third-party.test/token' },
    });
  };
  const client = new NetworkClient(config(), request);
  try {
    await expect(
      client.fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        body: 'client_secret=fixture',
      }),
    ).rejects.toThrow('请求体');
    expect(calls).toBe(1);
  } finally {
    await client.close();
  }
});
