import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { digest, type Vault } from '../../shared/crypto.js';
import { AppError } from '../../shared/errors.js';
export type ResultIdentity = {
  id: string;
  ownerId: string;
  profileId: string;
  credentialId: string;
};
export interface ResultStore {
  save(identity: ResultIdentity, result: unknown): Promise<string>;
  read(identity: ResultIdentity, expectedDigest: string): Promise<unknown>;
}
export class EncryptedResultStore implements ResultStore {
  constructor(
    private readonly directory: string,
    private readonly vault: Vault,
  ) {}
  private path(id: string) {
    return resolve(this.directory, `${z.uuid().parse(id)}.encrypted`);
  }
  private scope(identity: ResultIdentity) {
    return `rest:${identity.ownerId}:${identity.profileId}:${identity.credentialId}:${identity.id}`;
  }
  async save(identity: ResultIdentity, result: unknown) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = this.path(identity.id);
    const temporary = `${path}.${randomUUID()}.tmp`;
    const encrypted = this.vault.seal(result, this.scope(identity));
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(encrypted);
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await rename(temporary, path);
      const directory = await open(this.directory, 'r');
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch (error) {
      await unlink(temporary).catch((cleanup) => {
        if (cleanup.code !== 'ENOENT') throw cleanup;
      });
      throw error;
    }
    return digest(encrypted);
  }
  async read(identity: ResultIdentity, expectedDigest: string) {
    try {
      const encrypted = await readFile(this.path(identity.id), 'utf8');
      if (digest(encrypted) !== expectedDigest) throw new Error('Result digest mismatch');
      return this.vault.open<unknown>(encrypted, this.scope(identity));
    } catch {
      throw new AppError(
        'REST_RESULT_UNAVAILABLE',
        '保存的结果无法读取或解密；请检查匹配的数据卷和加密密钥，不会重放工具',
        500,
      );
    }
  }
}
