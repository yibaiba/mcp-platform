import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { win32 } from 'node:path';
import { getDefaultEnvironment } from '@modelcontextprotocol/client/stdio';
import semver from 'semver';
import type { McpbManifest, BundleLaunch } from '@platform/contracts';
import { AppError } from '../../shared/errors.js';
const execute = promisify(execFile);
export function runtimeRequirement(manifest: McpbManifest, launch: BundleLaunch) {
  const entries = Object.entries(manifest.compatibility?.runtimes ?? {});
  return entries.map(([runtime, range]) => {
    if (!['node', 'python'].includes(runtime))
      throw new AppError('MCPB_RUNTIME_UNSUPPORTED', '扩展包声明了不支持的运行时约束');
    const name = win32.basename(launch.command).replace(/\.exe$/i, '');
    if (
      runtime !== manifest.server.type ||
      !(runtime === 'node' ? /^(node|nodejs)$/ : /^python(?:[23](?:\.[0-9]+)?)?$/).test(name)
    )
      throw new AppError(
        'MCPB_RUNTIME_UNVERIFIABLE',
        '无法确认启动命令对应的运行时；请使用明确的 Node/Python 解释器',
      );
    if (!semver.validRange(range))
      throw new AppError('MCPB_RUNTIME_RANGE', '运行时版本约束不是有效的 SemVer 范围');
    return { runtime, range };
  });
}
export async function verifyRuntime(manifest: McpbManifest, launch: BundleLaunch) {
  for (const { runtime, range } of runtimeRequirement(manifest, launch)) {
    let stdout: string;
    try {
      ({ stdout } = await execute(launch.command, ['--version'], {
        timeout: 5000,
        encoding: 'utf8',
        cwd: launch.cwd,
        env: { ...getDefaultEnvironment(), ...launch.env },
      }));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      throw new AppError(
        'MCPB_RUNTIME_UNAVAILABLE',
        `运行时版本检查失败（${['ENOENT', 'EACCES', 'EPERM'].includes(String(code)) ? code : '无法启动、超时或非零退出'}）`,
      );
    }
    const version = stdout.trim().replace(/^(Python |v)/, '');
    if (!semver.valid(version)) throw new AppError('MCPB_RUNTIME_VERSION', '解释器未返回有效版本');
    if (!semver.satisfies(version, range))
      throw new AppError('MCPB_RUNTIME_INCOMPATIBLE', `${runtime} ${version} 不满足 ${range}`);
  }
}
