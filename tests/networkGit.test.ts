import { test, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { networkSettings } from '../packages/contracts/src/network.js';
import { NetworkClient, githubClone } from '../packages/network/src/index.js';
import { importGit } from '../apps/server/src/modules/skills/gitImporter.js';
import { checkNetwork } from '../apps/server/src/modules/network/checks.js';
const execute = promisify(execFile);
test('actual accelerated Git import preserves a fixed commit and checks API, download and Git independently', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'platform-network-git-'));
  const repository = join(directory, 'repo');
  await mkdir(repository);
  const git = (args: string[]) =>
    execute('git', args, {
      cwd: repository,
      timeout: 10_000,
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_AUTHOR_NAME: 'Fixture',
        GIT_AUTHOR_EMAIL: 'fixture@example.test',
        GIT_COMMITTER_NAME: 'Fixture',
        GIT_COMMITTER_EMAIL: 'fixture@example.test',
      },
    });
  await git(['init']);
  const original = '---\nname: fixed-fixture\n---\nOriginal fixed version\n';
  await writeFile(join(repository, 'SKILL.md'), original);
  await git(['add', 'SKILL.md']);
  await git(['commit', '-m', 'first']);
  const revision = (await git(['rev-parse', 'HEAD'])).stdout.trim();
  await writeFile(join(repository, 'SKILL.md'), original + 'Changed later\n');
  await git(['commit', '-am', 'second']);
  await mkdir(join(directory, 'yibaiba'));
  await git(['clone', '--bare', repository, join(directory, 'yibaiba/mcp-platform.git')]);
  await git(['--git-dir=' + join(directory, 'yibaiba/mcp-platform.git'), 'update-server-info']);
  const seen: { url: string; auth?: string }[] = [];
  let redirectGit = false;
  const server = createServer((req, res) => {
    const url = new URL(req.url!, 'http://fixture');
    seen.push({ url: url.pathname, auth: req.headers.authorization });
    if (url.pathname.startsWith('/api/')) {
      res.writeHead(503);
      res.end();
      return;
    }
    if (url.pathname.startsWith('/download/')) {
      res.end('download fixture');
      return;
    }
    if (redirectGit) {
      res.writeHead(302, { Location: 'http://127.0.0.1:1/blocked' });
      res.end();
      return;
    }
    if (req.headers.authorization !== 'Bearer separate-git-fixture') {
      res.writeHead(401);
      res.end();
      return;
    }
    const path = resolve(directory, '.' + url.pathname);
    if (!path.startsWith(directory + '/')) {
      res.writeHead(400);
      res.end();
      return;
    }
    void readFile(path)
      .then((data) => res.end(data))
      .catch(() => {
        res.writeHead(404);
        res.end();
      });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const config = {
    ...networkSettings.parse({
      githubApi: origin + '/api',
      githubDownload: origin + '/download/{encodedUrl}',
      githubClone: origin + '/{owner}/{repo}.git',
    }),
    secrets: { githubCloneToken: 'separate-git-fixture' },
  };
  const client = new NetworkClient(config);
  const network = {
    snapshot: async () => ({ config, revision: 1 }),
    fetch: client.fetch,
    git: async (url: string) => ({
      url: githubClone(url, config),
      env: {},
      token: config.secrets.githubCloneToken,
    }),
  };
  try {
    const imported = await importGit(
      { url: 'https://github.com/yibaiba/mcp-platform.git', revision },
      network,
    );
    expect(Buffer.from(imported.package.files['SKILL.md']!, 'base64').toString()).toBe(original);
    expect(imported.revision).toBe(revision);
    const checks = await checkNetwork(network);
    expect(checks.map(({ kind, ok }) => ({ kind, ok }))).toEqual([
      { kind: 'api', ok: false },
      { kind: 'download', ok: true },
      { kind: 'git', ok: true },
    ]);
    expect(
      seen
        .filter(
          (request) => request.url.startsWith('/api/') || request.url.startsWith('/download/'),
        )
        .every((request) => !request.auth),
    ).toBe(true);
    redirectGit = true;
    await expect(
      importGit({ url: 'https://github.com/yibaiba/mcp-platform.git', revision }, network),
    ).rejects.toMatchObject({ code: 'GIT_IMPORT_FAILED' });
  } finally {
    await client.close();
    await new Promise<void>((done) => server.close(() => done()));
    await rm(directory, { recursive: true, force: true });
  }
});
