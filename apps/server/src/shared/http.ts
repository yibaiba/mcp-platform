import type { Context } from 'hono';
import { z } from 'zod';
import { AppError } from './errors.js';
export type ApiEnv = { Variables: { ownerId: string } };
export const owner = (c: Context<ApiEnv>) => c.get('ownerId');
export const paramId = (c: Context<ApiEnv>, key = 'id') => z.uuid().parse(c.req.param(key));
export function bearer(headers: Headers) {
  const value = headers.get('authorization');
  if (!value?.startsWith('Bearer ') || value.length <= 7)
    throw new AppError('UNAUTHORIZED', '缺少 Bearer 凭证', 401);
  return value.slice(7);
}
