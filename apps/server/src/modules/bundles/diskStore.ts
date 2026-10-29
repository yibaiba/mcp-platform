import { mkdir, mkdtemp, writeFile, rename, rm, readFile, lstat, realpath } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { digest } from '../../shared/crypto.js';
import { safeRelativePath, filesDigest } from '../skills/packageService.js';
import { AppError } from '../../shared/errors.js';
export class BundleDiskStore {
  constructor(private readonly root: string) {}
  directory(ownerId: string, sha256: string) {
    if (!/^[a-f0-9]{64}$/.test(sha256)) throw new AppError('MCPB_DIGEST', '无效包摘要');
    return join(this.root, digest(ownerId), sha256);
  }
  remove(ownerId: string, sha256: string) {
    return rm(this.directory(ownerId, sha256), { recursive: true, force: true });
  }
  async extract(input: {
    ownerId: string;
    sha256: string;
    files: Record<string, string>;
    executable: string[];
    digest: string;
  }) {
    const target = this.directory(input.ownerId, input.sha256);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    const stage = await mkdtemp(join(dirname(target), '.stage-'));
    try {
      for (const [name, base64] of Object.entries(input.files)) {
        const path = join(stage, safeRelativePath(name));
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        await writeFile(path, Buffer.from(base64, 'base64'), {
          mode: input.executable.includes(name) ? 0o700 : 0o600,
          flag: 'wx',
        });
      }
      await writeFile(join(stage, '.platform-bundle-digest'), input.digest, {
        flag: 'wx',
        mode: 0o600,
      });
      try {
        await rename(stage, target);
      } catch (error) {
        if (!['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? ''))
          throw error;
        await this.verify(target, input);
      }
      return target;
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
  }
  private async verify(target: string, input: { files: Record<string, string>; digest: string }) {
    if (
      !(await lstat(target)).isDirectory() ||
      (await readFile(join(target, '.platform-bundle-digest'), 'utf8')) !== input.digest
    )
      throw new AppError('MCPB_CONFLICT', '已有安装目录不匹配');
    const canonicalRoot = await realpath(target);
    const files: Record<string, string> = {};
    for (const name of Object.keys(input.files)) {
      const path = join(target, safeRelativePath(name));
      if (!(await lstat(path)).isFile() || (await realpath(path)) !== join(canonicalRoot, name))
        throw new AppError('MCPB_CONFLICT', '已有安装文件类型改变');
      files[name] = (await readFile(path)).toString('base64');
    }
    if (filesDigest(files) !== input.digest)
      throw new AppError('MCPB_CONFLICT', '已有安装目录被修改');
  }
}
