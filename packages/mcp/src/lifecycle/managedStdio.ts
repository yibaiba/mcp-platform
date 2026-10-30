import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { resolve } from 'node:path';
import {
  deserializeMessage,
  serializeMessage,
  type JSONRPCMessage,
  type Transport,
} from '@modelcontextprotocol/client';
import { getDefaultEnvironment } from '@modelcontextprotocol/client/stdio';

const PYTHON_RUNTIME_ENV = [
  'UV_CACHE_DIR',
  'UV_TOOL_DIR',
  'UV_TOOL_BIN_DIR',
  'UV_PYTHON',
  'UV_PYTHON_DOWNLOADS',
] as const;
// Locale and temp keys a well-behaved CLI expects; nothing that can carry platform secrets.
const BASE_ENV = ['LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TMPDIR'] as const;
function pick(keys: readonly string[]) {
  return Object.fromEntries(
    keys.flatMap((key) => (process.env[key] === undefined ? [] : [[key, process.env[key]!]])),
  );
}
/**
 * Child environment is an allowlist: the SDK's minimal set (PATH, HOME, USER, SHELL, TERM, LOGNAME;
 * Windows system keys), locale/temp keys, uv runtime paths, then the connection's own configured
 * env. The server's own process env (database URL, auth/encryption keys) is never inherited.
 */
export function hostProcessEnvironment(env?: Record<string, string>): Record<string, string> {
  return { ...getDefaultEnvironment(), ...pick(BASE_ENV), ...pick(PYTHON_RUNTIME_ENV), ...env };
}

type Options = {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  shutdownGraceMs?: number;
};
export class ManagedStdioTransport implements Transport {
  readonly stderr = new PassThrough();
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  private child?: ChildProcessWithoutNullStreams;
  private stopping?: Promise<void>;
  private buffer = Buffer.alloc(0);
  constructor(private readonly options: Options) {}
  get pid() {
    return this.child?.pid ?? null;
  }
  async start() {
    if (this.child) throw new Error('托管进程已启动');
    const windows = process.platform === 'win32';
    const host =
      process.env.MCP_PROCESS_HOST ??
      resolve('connector/bin', `connector-windows-${process.arch}.exe`);
    const command = windows ? host : this.options.command;
    const args = windows
      ? [
          'stdio-host',
          '--grace',
          `${this.options.shutdownGraceMs ?? 5_000}ms`,
          '--',
          this.options.command,
          ...(this.options.args ?? []),
        ]
      : (this.options.args ?? []);
    const child = spawn(command, args, {
      env: hostProcessEnvironment(this.options.env),
      cwd: this.options.cwd,
      stdio: 'pipe',
      detached: !windows,
      shell: false,
    });
    this.child = child;
    child.stderr.pipe(this.stderr);
    child.stdin.on('error', (error) => this.onerror?.(error));
    child.stdout.on('error', (error) => this.onerror?.(error));
    child.stdout.on('data', (chunk: Buffer) => this.receive(chunk));
    child.once('exit', () => {
      this.onclose?.();
      void this.close().catch((error: Error) => this.onerror?.(error));
    });
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
  }
  private receive(chunk: Buffer) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    let index: number;
    while ((index = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.subarray(0, index).toString('utf8');
      this.buffer = this.buffer.subarray(index + 1);
      try {
        this.onmessage?.(deserializeMessage(line));
      } catch (error) {
        this.onerror?.(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }
  async send(message: JSONRPCMessage) {
    const child = this.child;
    if (!child?.stdin.writable) throw new Error('托管进程输入已关闭');
    await new Promise<void>((resolve, reject) =>
      child.stdin.write(serializeMessage(message), (error) => (error ? reject(error) : resolve())),
    );
  }
  close() {
    return (this.stopping ??= this.terminate());
  }
  private async terminate() {
    const child = this.child;
    const pid = child?.pid;
    if (!pid || !child) return;
    child.stdin.end();
    if (process.platform === 'win32') {
      if (child.exitCode === null && child.signalCode === null)
        await new Promise<void>((resolve) => child.once('exit', resolve));
      this.child = undefined;
      this.stderr.end();
      return;
    }
    signalGroup(pid, 'SIGTERM');
    const deadline = Date.now() + (this.options.shutdownGraceMs ?? 5_000);
    while (groupExists(pid) && Date.now() < deadline)
      await delay(Math.min(50, Math.max(1, deadline - Date.now())));
    if (groupExists(pid)) signalGroup(pid, 'SIGKILL');
    if (child.exitCode === null && child.signalCode === null)
      await new Promise<void>((resolve) => child.once('exit', resolve));
    this.child = undefined;
    this.stderr.end();
  }
}
function groupExists(pid: number) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}
function signalGroup(pid: number, signal: NodeJS.Signals) {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}
