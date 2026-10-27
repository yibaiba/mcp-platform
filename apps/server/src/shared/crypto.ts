import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
export const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export const secretToken = () => randomBytes(32).toString('base64url');
export class Vault {
  private readonly key: Buffer;
  constructor(base64Key: string) {
    this.key = Buffer.from(base64Key, 'base64');
    if (this.key.length !== 32 || this.key.toString('base64') !== base64Key)
      throw new Error('ENCRYPTION_KEY must be canonical base64 for 32 bytes');
  }
  seal(value: unknown, scope: string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(scope));
    const data = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    return [iv, cipher.getAuthTag(), data].map((v) => v.toString('base64')).join('.');
  }
  open<T>(value: string, scope: string): T {
    const parts = value.split('.').map((v) => Buffer.from(v, 'base64'));
    const [iv, tag, data] = parts;
    if (!iv || !tag || !data || parts.length !== 3) throw new Error('Invalid credential envelope');
    const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAAD(Buffer.from(scope));
    decipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([decipher.update(data), decipher.final()]).toString()) as T;
  }
}
