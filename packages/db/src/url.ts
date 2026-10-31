import { readFileSync } from 'node:fs';
/**
 * DATABASE_URL, optionally completed with a password read from DATABASE_PASSWORD_FILE (the
 * bundled Compose generates the database password into a 0600 file instead of `.env`). A
 * password already in the URL wins.
 */
export function databaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.DATABASE_URL;
  if (!raw) throw new Error('DATABASE_URL is required');
  const file = env.DATABASE_PASSWORD_FILE;
  if (!file) return raw;
  const url = new URL(raw);
  if (url.password) return raw;
  let password: string;
  try {
    password = readFileSync(file, 'utf8').trim();
  } catch (error) {
    throw new Error(
      `无法读取 DATABASE_PASSWORD_FILE（${file}）：${(error as Error).message}。请确认文件存在且当前用户可读，或在 DATABASE_URL 里直接写密码`,
      { cause: error },
    );
  }
  if (!password) throw new Error(`DATABASE_PASSWORD_FILE（${file}）是空文件`);
  url.password = encodeURIComponent(password);
  return url.toString();
}
