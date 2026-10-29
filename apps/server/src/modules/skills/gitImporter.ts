import { gitEnvironment } from '../network/checks.js';
import type { NetworkService } from '../network/service.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { parse } from 'yaml';
import { safeRelativePath } from './packageService.js';
import { AppError } from '../../shared/errors.js';
const execute = promisify(execFile);
const gitInput = z
  .object({
    url: z.url().refine((v) => {
      const u = new URL(v);
      return u.protocol === 'https:' && !u.username && !u.password;
    }),
    revision: z.string().regex(/^[a-f0-9]{40}$/),
    path: z.string().default(''),
    dependencies: z.array(z.string()).default([]),
  })
  .strict();
export async function importGit(input: unknown, network?: Pick<NetworkService, 'git'>) {
  const value = gitInput.parse(input);
  if (value.path) safeRelativePath(value.path);
  const target = network ? await network.git(value.url) : { url: value.url, env: {} };
  const directory = await mkdtemp(join(tmpdir(), 'platform-skill-'));
  const run = (args: string[]) =>
    execute(
      'git',
      [
        '-c',
        'http.followRedirects=false',
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'protocol.file.allow=never',
        ...args,
      ],
      {
        cwd: directory,
        timeout: 60_000,
        maxBuffer: 32 * 1024 * 1024,
        encoding: 'buffer',
        env: {
          ...gitEnvironment(target),
          HOME: directory,
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_TERMINAL_PROMPT: '0',
        },
      },
    );
  try {
    await run(['clone', '--no-checkout', '--', target.url, 'repo']);
    const prefix = value.path ? `${value.path}/` : '';
    const { stdout } = await run([
      '-C',
      'repo',
      'ls-tree',
      '-r',
      '-z',
      value.revision,
      '--',
      value.path || '.',
    ]);
    const files: Record<string, string> = {};
    for (const entry of stdout.toString('utf8').split('\0').filter(Boolean)) {
      const match = /^(\d+) blob ([a-f0-9]+)\t(.+)$/.exec(entry);
      if (!match || !['100644', '100755'].includes(match[1]!))
        throw new AppError('UNSAFE_GIT_ENTRY', '不支持符号链接、子模块或特殊文件');
      const path = match[3]!;
      if (!path.startsWith(prefix)) throw new AppError('INVALID_PATH', 'Git 路径不匹配');
      const content = await run(['-C', 'repo', 'cat-file', 'blob', match[2]!]);
      files[safeRelativePath(path.slice(prefix.length))] = content.stdout.toString('base64');
    }
    const source = Buffer.from(files['SKILL.md'] ?? '', 'base64').toString('utf8');
    const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source);
    if (!match) throw new AppError('INVALID_SKILL', '所选目录缺少 SKILL.md');
    const metadata = z.object({ name: z.string() }).passthrough().parse(parse(match[1]!));
    return {
      package: { name: metadata.name, files, dependencies: value.dependencies },
      source: value.url,
      revision: value.revision,
    };
  } catch {
    throw new AppError(
      'GIT_IMPORT_FAILED',
      'Git 导入失败；请检查地址、固定提交、目录、代理与凭证',
      502,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
