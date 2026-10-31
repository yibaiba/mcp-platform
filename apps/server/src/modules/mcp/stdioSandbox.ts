import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { AppError } from '../../shared/errors.js';

/**
 * Optional bubblewrap sandbox for platform-host stdio processes (STDIO_SANDBOX=bwrap; default off).
 *
 * Profile (minimal, not a container): every namespace unshared except the network; the host root
 * mounted read-only; fresh /dev, /proc and /tmp; the platform data directory (secrets, other
 * connections' state) replaced by an empty tmpfs; a private writable HOME per connection under
 * DATA_DIR/sandbox; the uv tool/cache directories and the connection's own cwd writable; `.env`
 * files next to the server masked. The child is killed with the server (--die-with-parent).
 * When the switch is on but bwrap cannot run, the connection fails with STDIO_SANDBOX_UNAVAILABLE:
 * it is never started outside the sandbox.
 */
export type StdioSandboxMode = 'off' | 'bwrap';
export type StdioSandboxStatus =
  | { mode: 'off' }
  | { mode: 'bwrap'; ready: true; version: string; path: string; proc: 'proc' | 'bind' }
  | { mode: 'bwrap'; ready: false; error: string; hint: string };
type Launch = { command?: string; args: string[]; env: Record<string, string>; cwd?: string };
type Run = (
  file: string,
  args: string[],
) => Promise<{ ok: true; stdout: string } | { ok: false; code?: string; stderr: string }>;

const run: Run = (file, args) =>
  new Promise((done) =>
    execFile(file, args, { timeout: 5000, encoding: 'utf8' }, (error, stdout, stderr) =>
      done(
        error
          ? {
              ok: false,
              code: (error as NodeJS.ErrnoException).code?.toString(),
              stderr: String(stderr || error.message),
            }
          : { ok: true, stdout },
      ),
    ),
  );
const FAILURE_TTL_MS = 30_000;
export const SANDBOX_DOCS = 'docs/deployment.md#stdio-沙箱';

export class StdioSandbox {
  private probed?: { at: number; status: Promise<StdioSandboxStatus> };
  constructor(
    private readonly deps: {
      mode: StdioSandboxMode;
      dataDir: string;
      /** Explicit bwrap binary; otherwise `bwrap` is looked up on the server's PATH. */
      bwrap?: string;
      run?: Run;
      env?: NodeJS.ProcessEnv;
      platform?: NodeJS.Platform;
    },
  ) {}
  get mode() {
    return this.deps.mode;
  }
  /** Probe result; success is cached, failure re-probed after 30 s so a fix needs no restart. */
  status(): Promise<StdioSandboxStatus> {
    if (this.deps.mode === 'off') return Promise.resolve({ mode: 'off' });
    const cached = this.probed;
    if (cached && Date.now() - cached.at < FAILURE_TTL_MS) return cached.status;
    const status = this.probe();
    this.probed = { at: Date.now(), status };
    void status.then((value) => {
      if (value.mode === 'bwrap' && value.ready && this.probed?.status === status)
        this.probed = { at: Number.POSITIVE_INFINITY, status };
    });
    return status;
  }
  private async probe(): Promise<StdioSandboxStatus> {
    const platform = this.deps.platform ?? process.platform;
    if (platform !== 'linux')
      return unavailable(
        `bubblewrap 只支持 Linux，当前平台是 ${platform}`,
        '把 STDIO_SANDBOX 设为 off，或在 Linux 上运行平台服务',
      );
    const path = this.locate();
    if (!path)
      return unavailable(
        '平台服务所在的机器上找不到 bwrap',
        '安装 bubblewrap（Debian/Ubuntu：apt-get install bubblewrap；官方镜像已内置），或把 STDIO_SANDBOX 设为 off',
      );
    const exec = this.deps.run ?? run;
    const version = await exec(path, ['--version']);
    if (!version.ok)
      return unavailable(
        `bwrap 无法运行（${version.code ?? firstLine(version.stderr)}）`,
        hint(''),
      );
    // A real namespace round-trip; a fresh /proc first, then the host /proc (Docker masks paths
    // under /proc, which makes mounting a new procfs fail without systempaths=unconfined).
    let last = '';
    for (const proc of ['proc', 'bind'] as const) {
      const result = await exec(path, [
        ...this.profile({ proc, home: await this.probeHome() }),
        '--',
        process.execPath,
        '-e',
        '',
      ]);
      if (result.ok)
        return {
          mode: 'bwrap',
          ready: true,
          version: version.stdout.trim().replace(/^bubblewrap\s*/, ''),
          path,
          proc,
        };
      last = firstLine(result.stderr);
    }
    return unavailable(`bwrap 无法创建沙箱（${last || '未知错误'}）`, hint(last));
  }
  private async probeHome() {
    const home = join(resolve(this.deps.dataDir), 'sandbox', '.probe');
    await mkdir(home, { recursive: true });
    return home;
  }
  private locate() {
    const configured = this.deps.bwrap;
    if (configured)
      return isAbsolute(configured) && existsSync(configured) ? configured : undefined;
    const env = this.deps.env ?? process.env;
    for (const dir of (env.PATH ?? '').split(delimiter).filter(Boolean)) {
      const candidate = join(dir, 'bwrap');
      if (existsSync(candidate)) return candidate;
    }
    return undefined;
  }
  /** bwrap options for one launch. Order matters: later mounts sit on top of earlier ones. */
  private profile(input: {
    proc: 'proc' | 'bind';
    home: string;
    cwd?: string;
    /** Paths inside the data directory that this launch names (bundle files, config files). */
    referenced?: string[];
  }) {
    const dataDir = resolve(this.deps.dataDir);
    const env = this.deps.env ?? process.env;
    const args = [
      '--die-with-parent',
      '--unshare-all',
      '--share-net',
      '--ro-bind',
      '/',
      '/',
      '--dev',
      '/dev',
      ...(input.proc === 'proc' ? ['--proc', '/proc'] : ['--ro-bind', '/proc', '/proc']),
      '--tmpfs',
      '/tmp',
      '--tmpfs',
      dataDir,
    ];
    for (const key of ['UV_CACHE_DIR', 'UV_TOOL_DIR', 'UV_TOOL_BIN_DIR']) {
      const dir = env[key] && resolve(env[key]!);
      if (dir && existsSync(dir)) args.push('--bind', dir, dir);
    }
    for (const path of input.referenced ?? []) args.push('--ro-bind', path, path);
    args.push('--bind', input.home, input.home);
    if (input.cwd) args.push('--bind', input.cwd, input.cwd, '--chdir', input.cwd);
    for (const file of envFiles()) args.push('--ro-bind', '/dev/null', file);
    return args;
  }
  /**
   * Returns the launch rewritten to run inside bwrap, or unchanged when the switch is off.
   * `key` names the connection runtime; it selects the private HOME.
   */
  async wrap<T extends Launch>(launch: T, key: string): Promise<T> {
    if (this.deps.mode === 'off') return launch;
    const status = await this.status();
    if (status.mode !== 'bwrap' || !status.ready)
      throw new AppError(
        'STDIO_SANDBOX_UNAVAILABLE',
        `已开启 stdio 沙箱（STDIO_SANDBOX=bwrap），但${status.mode === 'bwrap' ? status.error : '沙箱未就绪'}。${status.mode === 'bwrap' ? status.hint : ''}。这个连接没有启动，也不会在沙箱外运行（见 ${SANDBOX_DOCS}）`,
        503,
      );
    if (!launch.command) throw new AppError('STDIO_COMMAND', 'stdio 连接缺少启动命令');
    // Runtime keys can be long (shares, bindings); a digest keeps one short directory per runtime.
    const slot = createHash('sha256').update(key).digest('hex').slice(0, 32);
    const home = join(resolve(this.deps.dataDir), 'sandbox', slot, 'home');
    await mkdir(home, { recursive: true });
    const cwd = launch.cwd ? resolve(launch.cwd) : undefined;
    const dataDir = resolve(this.deps.dataDir);
    const referenced = [
      ...new Set(
        [launch.command, ...launch.args, ...Object.values(launch.env)]
          .flatMap((value) => [value, value.split('=').at(-1)!])
          .filter((value) => value.startsWith(`${dataDir}/`) && existsSync(value)),
      ),
    ];
    return {
      ...launch,
      command: status.path,
      args: [
        ...this.profile({ proc: status.proc, home, cwd, referenced }),
        '--',
        launch.command,
        ...launch.args,
      ],
      env: { ...launch.env, HOME: home },
    };
  }
}
function unavailable(error: string, hint: string): StdioSandboxStatus {
  return { mode: 'bwrap', ready: false, error, hint };
}
function firstLine(text: string) {
  return text.trim().split('\n')[0]?.slice(0, 200) ?? '';
}
function hint(stderr: string) {
  return /permission|not permitted|uid map|namespace/i.test(stderr)
    ? '当前环境不允许创建用户命名空间：容器里需要 --security-opt seccomp=unconfined 和 --security-opt apparmor=unconfined，Ubuntu 23.10+ 等宿主机还需 sysctl kernel.apparmor_restrict_unprivileged_userns=0；或把 STDIO_SANDBOX 设为 off'
    : '检查 bwrap 安装与内核用户命名空间设置（/proc/sys/user/max_user_namespaces 大于 0），或把 STDIO_SANDBOX 设为 off';
}
/** `.env` files in the server's working directory and its parents (repo-root .env in dev). */
function envFiles() {
  const files: string[] = [];
  for (let dir = process.cwd(); ; dir = dirname(dir)) {
    const file = join(dir, '.env');
    if (existsSync(file)) files.push(file);
    if (dirname(dir) === dir) break;
  }
  return files;
}
