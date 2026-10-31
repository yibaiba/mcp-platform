import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { StdioSandbox } from '../apps/server/src/modules/mcp/stdioSandbox.js';
import { harness } from './harness.js';

const tsx = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
const probeServer = (name: string, adapter: 'direct' | 'pi' = 'direct') => ({
  name,
  adapter,
  transport: 'stdio',
  mode: 'managed',
  command: process.execPath,
  args: ['--import', tsx, resolve('tests/fixtureSandboxProbe.mts')],
});
/** True when this machine can actually run bwrap (CI runners and the review box can). */
const bwrapUsable = (() => {
  try {
    execFileSync('bwrap', ['--unshare-all', '--ro-bind', '/', '/', '--', 'true'], {
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
})();

describe('sandbox decisions', () => {
  const launch = { command: '/bin/sh', args: ['-c', 'id'], env: { A: '1' } };
  test('off is the default and leaves the launch untouched (same object)', async () => {
    const sandbox = new StdioSandbox({ mode: 'off', dataDir: '/data' });
    await expect(sandbox.wrap(launch, 'c1')).resolves.toBe(launch);
    await expect(sandbox.status()).resolves.toEqual({ mode: 'off' });
  });
  test('switch on without bwrap fails closed with an install hint', async () => {
    const sandbox = new StdioSandbox({
      mode: 'bwrap',
      dataDir: '/data',
      env: { PATH: '/nonexistent' },
      platform: 'linux',
    });
    await expect(sandbox.status()).resolves.toMatchObject({
      ready: false,
      error: '平台服务所在的机器上找不到 bwrap',
      hint: expect.stringContaining('apt-get install bubblewrap'),
    });
    await expect(sandbox.wrap(launch, 'c1')).rejects.toMatchObject({
      code: 'STDIO_SANDBOX_UNAVAILABLE',
      status: 503,
      message: expect.stringContaining('不会在沙箱外运行'),
    });
  });
  test('non-Linux hosts are reported, not silently unsandboxed', async () => {
    const sandbox = new StdioSandbox({ mode: 'bwrap', dataDir: '/data', platform: 'darwin' });
    await expect(sandbox.wrap(launch, 'c1')).rejects.toMatchObject({
      code: 'STDIO_SANDBOX_UNAVAILABLE',
      message: expect.stringContaining('只支持 Linux'),
    });
  });
  test('a blocked user namespace (default Docker seccomp/AppArmor) names the container options', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sandbox-unit-'));
    const fake = join(dir, 'bwrap');
    await writeFile(fake, '');
    const calls: string[][] = [];
    const sandbox = new StdioSandbox({
      mode: 'bwrap',
      dataDir: dir,
      bwrap: fake,
      platform: 'linux',
      run: async (_file, args) => {
        calls.push(args);
        return args[0] === '--version'
          ? { ok: true, stdout: 'bubblewrap 0.8.0\n' }
          : {
              ok: false,
              stderr:
                'bwrap: No permissions to creating new namespace, likely because the kernel does not allow non-privileged user namespaces.\n',
            };
      },
    });
    const status = await sandbox.status();
    expect(status).toMatchObject({
      ready: false,
      hint: expect.stringContaining('seccomp=unconfined'),
    });
    // --version, then both /proc strategies, before giving up.
    expect(calls).toHaveLength(3);
    expect(calls[1]).toEqual(expect.arrayContaining(['--proc', '/proc']));
    expect(calls[2]).not.toContain('--proc');
    await rm(dir, { recursive: true, force: true });
  });
  test('a masked /proc falls back to binding the host /proc', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sandbox-unit-'));
    const fake = join(dir, 'bwrap');
    await writeFile(fake, '');
    const sandbox = new StdioSandbox({
      mode: 'bwrap',
      dataDir: dir,
      bwrap: fake,
      platform: 'linux',
      run: async (_file, args) =>
        args[0] === '--version'
          ? { ok: true, stdout: 'bubblewrap 0.8.0\n' }
          : args.includes('--proc')
            ? {
                ok: false,
                stderr: "bwrap: Can't mount proc on /newroot/proc: Operation not permitted\n",
              }
            : { ok: true, stdout: '' },
    });
    await expect(sandbox.status()).resolves.toMatchObject({
      ready: true,
      version: '0.8.0',
      proc: 'bind',
    });
    const wrapped = await sandbox.wrap({ command: 'npx', args: ['-y', 'pkg'], env: {} }, 'conn/1');
    expect(wrapped.command).toBe(fake);
    expect(wrapped.args).toEqual(
      expect.arrayContaining(['--ro-bind', '/proc', '--tmpfs', dir, '--', 'npx', '-y', 'pkg']),
    );
    expect(wrapped.env.HOME).toMatch(new RegExp(`^${dir}/sandbox/[0-9a-f]{32}/home$`));
    expect(existsSync(wrapped.env.HOME)).toBe(true);
    await rm(dir, { recursive: true, force: true });
  });
});

describe.skipIf(!bwrapUsable)('real bubblewrap around platform-host stdio', () => {
  let h: Awaited<ReturnType<typeof harness>>;
  let secret: string;
  let outside: string;
  beforeAll(async () => {
    h = await harness({ env: { STDIO_SANDBOX: 'bwrap' } });
    secret = join(h.directory, 'secrets', 'sandbox-test-secret');
    await mkdir(join(h.directory, 'secrets'), { recursive: true });
    await writeFile(secret, 'top secret');
    // A writable host location (the repo checkout): read-only inside the sandbox.
    outside = resolve('tests', `.sandbox-write-${process.pid}`);
    await rm('/tmp/sandbox-probe.txt', { force: true });
  });
  afterAll(async () => {
    await h?.close();
    await rm(outside, { force: true });
    // Closing the platform stops bwrap and everything inside its pid namespace.
    const left = (() => {
      try {
        return execFileSync('pgrep', ['-f', 'fixtureSandboxProbe'], { encoding: 'utf8' }).trim();
      } catch {
        return '';
      }
    })();
    expect(left).toBe('');
  });
  test.each(['direct', 'pi'] as const)(
    '%s: the child sees a read-only host, no platform data, a private HOME and its own pid namespace',
    async (adapter) => {
      const admin = await h.signup({ role: 'admin' });
      const me = await (await admin.request('/me')).json();
      expect(me.stdioSandbox).toMatchObject({ mode: 'bwrap', ready: true });
      const connection = await h.services.connections.create(
        admin.ownerId,
        probeServer(`probe-${adapter}`, adapter),
      );
      const [tool] = await h.services.connections.discover(admin.ownerId, connection.id);
      const result = await h.services.invocations.call({
        ownerId: admin.ownerId,
        toolId: tool!.id,
        arguments: { secret, outside },
      });
      const seen = result.structuredContent as Record<string, unknown>;
      expect(seen).toMatchObject({
        readSecret: false,
        writeOutside: false,
        writeHome: true,
        writeTmp: true,
      });
      expect(String(seen.home).startsWith(join(resolve(h.directory), 'sandbox'))).toBe(true);
      // pid 1 of the child's namespace is bubblewrap's own init, not the host's.
      expect(String(seen.pid1)).toMatch(/bwrap$/);
      expect(existsSync(outside)).toBe(false);
      // /tmp inside is a private tmpfs; the host /tmp is untouched.
      expect(existsSync('/tmp/sandbox-probe.txt')).toBe(false);
      // The private HOME persists on the host, under the data directory.
      expect(existsSync(join(String(seen.home), 'probe.txt'))).toBe(true);
    },
  );
  test('turning the sandbox off restores the previous, unsandboxed launch', async () => {
    const plain = await harness();
    try {
      const admin = await plain.signup({ role: 'admin' });
      const connection = await plain.services.connections.create(
        admin.ownerId,
        probeServer('plain'),
      );
      const [tool] = await plain.services.connections.discover(admin.ownerId, connection.id);
      const file = join(plain.directory, 'plain-secret');
      await writeFile(file, 'x');
      const result = await plain.services.invocations.call({
        ownerId: admin.ownerId,
        toolId: tool!.id,
        arguments: { secret: file, outside: join(plain.directory, 'plain-outside') },
      });
      expect(result.structuredContent).toMatchObject({
        readSecret: true,
        writeOutside: true,
        home: process.env.HOME,
      });
    } finally {
      await plain.close();
      await rm('/tmp/sandbox-probe.txt', { force: true });
    }
  });
});

test('switch on with an unusable bwrap: the connection is refused with a clear error and the command never runs', async () => {
  const h = await harness({
    env: { STDIO_SANDBOX: 'bwrap', STDIO_SANDBOX_BWRAP: '/nonexistent/bwrap' },
  });
  try {
    const admin = await h.signup({ role: 'admin' });
    const me = await (await admin.request('/me')).json();
    expect(me.stdioSandbox).toMatchObject({ mode: 'bwrap', ready: false });
    const marker = join(h.directory, 'unsandboxed.ran');
    const response = await admin.request('/connections', {
      method: 'POST',
      body: JSON.stringify({
        name: 'shell',
        adapter: 'direct',
        transport: 'stdio',
        mode: 'managed',
        command: '/bin/sh',
        args: ['-c', `touch '${marker}'`],
      }),
    });
    expect(response.status).toBe(201);
    const { id } = await response.json();
    const discover = await admin.request(`/connections/${id}/discover`, { method: 'POST' });
    expect(discover.ok).toBe(false);
    expect(await discover.json()).toMatchObject({ code: 'STDIO_SANDBOX_UNAVAILABLE' });
    await new Promise((done) => setTimeout(done, 200));
    expect(existsSync(marker)).toBe(false);
  } finally {
    await h.close();
  }
});
