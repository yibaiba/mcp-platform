import { z } from 'zod';
export const managementScope = z.enum(['management:read', 'management:write']);
export const managementScopes = z
  .array(managementScope)
  .min(1)
  .refine((value) => new Set(value).size === value.length, '权限不能重复');
export const cliAuthorize = z
  .object({
    redirect_uri: z.url().refine((raw) => {
      const url = new URL(raw);
      return (
        url.protocol === 'http:' &&
        url.hostname === '127.0.0.1' &&
        Number(url.port) > 0 &&
        url.pathname === '/callback' &&
        !url.search &&
        !url.hash &&
        !url.username &&
        !url.password
      );
    }, 'CLI 回调必须为本次本机回环端口的 http://127.0.0.1:端口/callback'),
    code_challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    code_challenge_method: z.literal('S256'),
    state: z.string().regex(/^[A-Za-z0-9_-]{32,128}$/),
    scope: z
      .string()
      .transform((value) => value.split(' '))
      .pipe(managementScopes),
  })
  .strict();
export const cliTokenInput = z.discriminatedUnion('grant_type', [
  z
    .object({
      grant_type: z.literal('authorization_code'),
      code: z.string().min(1),
      redirect_uri: z.string(),
      code_verifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/),
    })
    .strict(),
  z.object({ grant_type: z.literal('refresh_token'), refresh_token: z.string().min(1) }).strict(),
]);
export type ManagementScope = z.infer<typeof managementScope>;
