import { z } from 'zod';
const endpoint = z.string().refine((value) => {
  if (!value) return true;
  try {
    const url = new URL(value);
    return (
      ['http:', 'https:'].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.hash &&
      !url.search
    );
  } catch {
    return false;
  }
}, '请输入不含凭证、查询参数或片段的 HTTP(S) 地址');
const template = (kind: 'download' | 'clone') =>
  z.string().refine((value) => {
    if (!value) return true;
    const tokens: string[] = value.match(/\{[^{}]*\}/g) ?? [];
    const allowed: string[] =
      kind === 'download' ? ['{url}', '{encodedUrl}'] : ['{owner}', '{repo}'];
    if (tokens.some((token) => !allowed.includes(token))) return false;
    if (
      kind === 'download' ? tokens.length !== 1 : !allowed.every((token) => tokens.includes(token))
    )
      return false;
    try {
      const url = new URL(
        value
          .replaceAll('{url}', 'https://github.com/owner/repo/archive/ref.zip')
          .replaceAll('{encodedUrl}', 'https%3A%2F%2Fgithub.com%2Fowner%2Frepo')
          .replaceAll('{owner}', 'owner')
          .replaceAll('{repo}', 'repo'),
      );
      return (
        ['http:', 'https:'].includes(url.protocol) &&
        !url.username &&
        !url.password &&
        !url.hash &&
        !/[{}]/.test(url.host) &&
        !value.split('://')[1]?.split('/')[0]?.includes('{')
      );
    } catch {
      return false;
    }
  }, '模板必须有固定 HTTP(S) 主机并使用指定占位符');
export const networkSettings = z
  .object({
    httpProxy: endpoint.default(''),
    httpsProxy: endpoint.default(''),
    noProxy: z.string().default(''),
    npmRegistry: endpoint.default(''),
    pythonIndex: endpoint.default(''),
    replacePublicSources: z.boolean().default(false),
    githubApi: endpoint.default(''),
    githubDownload: template('download').default(''),
    githubClone: template('clone').default(''),
  })
  .strict();
export type NetworkSettings = z.infer<typeof networkSettings>;
export const networkSecretNames = [
  'httpProxyAuth',
  'httpsProxyAuth',
  'githubApiToken',
  'githubDownloadToken',
  'githubCloneToken',
] as const;
export type NetworkSecrets = Partial<Record<(typeof networkSecretNames)[number], string>>;
export type NetworkConfig = NetworkSettings & { secrets: NetworkSecrets };
const secretEdit = z.discriminatedUnion('action', [
  z.object({ action: z.literal('keep') }).strict(),
  z.object({ action: z.literal('clear') }).strict(),
  z
    .object({
      action: z.literal('replace'),
      value: z
        .string()
        .min(1)
        .refine((v) => !/[\r\n]/.test(v), '凭证不能包含换行'),
    })
    .strict(),
]);
export const networkSave = z
  .object({
    revision: z.number().int().nonnegative(),
    settings: networkSettings,
    secrets: z.partialRecord(z.enum(networkSecretNames), secretEdit).default({}),
  })
  .strict();
export type NetworkView = {
  revision: number;
  settings: NetworkSettings;
  secrets: Record<(typeof networkSecretNames)[number], boolean>;
};
