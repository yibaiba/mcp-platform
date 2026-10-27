import { createHash } from 'node:crypto';
import { z } from 'zod';
import { parse } from 'yaml';
import { unzipSync } from 'fflate';
import { skillPackage, type SkillPackage } from '@platform/contracts';
import { AppError } from '../../shared/errors.js';
export function safeRelativePath(path: string) {
  if (
    !path ||
    path.includes('\\') ||
    path.includes('\0') ||
    path.includes(':') ||
    path.startsWith('/') ||
    path.split('/').some((part) => !part || part === '.' || part === '..')
  )
    throw new AppError('INVALID_PATH', `不安全的相对路径：${path}`);
  return path;
}
export function filesDigest(files: Record<string, string>) {
  const manifest = Object.keys(files)
    .sort()
    .map(
      (path) =>
        `${path}\0${createHash('sha256').update(Buffer.from(files[path]!, 'base64')).digest('hex')}\n`,
    )
    .join('');
  return createHash('sha256').update(manifest).digest('hex');
}
export function validatePackage(input: unknown) {
  const value = skillPackage.parse(input);
  for (const [path, content] of Object.entries(value.files)) {
    safeRelativePath(path);
    if (Buffer.from(content, 'base64').toString('base64') !== content)
      throw new AppError('INVALID_FILE', `文件不是规范 Base64：${path}`);
  }
  const source = Buffer.from(value.files['SKILL.md'] ?? '', 'base64').toString('utf8');
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source);
  if (!frontmatter) throw new AppError('INVALID_SKILL', 'SKILL.md 必须包含 YAML frontmatter');
  const metadata = z
    .object({ name: z.literal(value.name), description: z.string().min(1) })
    .passthrough()
    .parse(parse(frontmatter[1]!));
  return { ...value, metadata, digest: filesDigest(value.files) };
}
export function unpackZip(data: Uint8Array, dependencies: string[]): SkillPackage {
  const entries = unzipSync(data);
  const files: Record<string, string> = {};
  for (const [path, content] of Object.entries(entries)) {
    if (path.endsWith('/')) {
      safeRelativePath(path.slice(0, -1));
      continue;
    }
    files[safeRelativePath(path)] = Buffer.from(content).toString('base64');
  }
  const source = Buffer.from(files['SKILL.md'] ?? '', 'base64').toString('utf8');
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source);
  if (!frontmatter) throw new AppError('INVALID_SKILL', 'ZIP 根目录必须包含 SKILL.md');
  const metadata = z.object({ name: z.string() }).passthrough().parse(parse(frontmatter[1]!));
  return { name: metadata.name, files, dependencies };
}
