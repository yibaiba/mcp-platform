import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, openAsBlob } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { AppError } from '../../shared/errors.js';
export interface FileStore {
  write(input: {
    id: string;
    body: ReadableStream<Uint8Array>;
    sha256?: string;
  }): Promise<{ size: number; sha256: string }>;
  blob(id: string): Promise<Blob>;
  exists(id: string): Promise<boolean>;
  read(id: string): ReadableStream<Uint8Array>;
  remove(id: string): Promise<void>;
}
export class DiskFileStore implements FileStore {
  constructor(private readonly directory: string) {}
  async write(input: { id: string; body: ReadableStream<Uint8Array>; sha256?: string }) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = join(this.directory, `${input.id}.${randomUUID()}.tmp`);
    const hash = createHash('sha256');
    let size = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        size += chunk.length;
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    try {
      await pipeline(
        Readable.fromWeb(input.body as import('node:stream/web').ReadableStream),
        meter,
        createWriteStream(temporary, { flags: 'wx', mode: 0o600 }),
      );
      const sha256 = hash.digest('hex');
      if (input.sha256 !== undefined && sha256 !== input.sha256)
        throw new AppError('CHECKSUM_MISMATCH', '文件 SHA-256 校验失败');
      await rename(temporary, join(this.directory, input.id));
      return { size, sha256 };
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }
  blob(id: string) {
    return openAsBlob(join(this.directory, id));
  }
  async exists(id: string) {
    try {
      await stat(join(this.directory, id));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }
  read(id: string) {
    return Readable.toWeb(createReadStream(join(this.directory, id))) as ReadableStream<Uint8Array>;
  }
  remove(id: string) {
    return rm(join(this.directory, id), { force: true });
  }
}
