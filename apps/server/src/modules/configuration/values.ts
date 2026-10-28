import { z } from 'zod';
import {
  connectionInput,
  type ManifestApply,
  type ManifestConnection,
  type ManifestMappings,
} from '@platform/contracts';
import { AppError } from '../../shared/errors.js';
import { digest } from '../../shared/crypto.js';

export class DeploymentPending extends AppError {
  constructor(message: string) {
    super('DEPLOYMENT_PENDING', message, 409);
  }
}
const reference = z
  .object({ secretRef: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/) })
  .strict();
const directory = z
  .object({ directoryRef: z.string().regex(/^[\p{L}\p{N}][\p{L}\p{N}_. @-]*$/u) })
  .strict();
export function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
export const fingerprint = (value: unknown) => digest(stable(value));
export async function resolveValues(
  value: unknown,
  deps: {
    secret: (name: string) => Promise<string>;
    directory: (name: string) => Promise<string>;
  },
): Promise<unknown> {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return Promise.all(value.map((item) => resolveValues(item, deps)));
  if ('secretRef' in value) return deps.secret(reference.parse(value).secretRef);
  if ('directoryRef' in value) return deps.directory(directory.parse(value).directoryRef);
  return Object.fromEntries(
    await Promise.all(
      Object.entries(value).map(async ([key, item]) => [key, await resolveValues(item, deps)]),
    ),
  );
}
function validationValues(value: unknown, key = ''): unknown {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => validationValues(item, key));
  if ('secretRef' in value) {
    reference.parse(value);
    return /url|endpoint/i.test(key) ? 'https://pending.invalid/' : 'pending';
  }
  if ('directoryRef' in value) {
    directory.parse(value);
    return '/pending';
  }
  return Object.fromEntries(
    Object.entries(value).map(([name, item]) => [name, validationValues(item, name)]),
  );
}
export function validateDeclaration(input: ManifestApply) {
  const names = new Set(Object.keys(input.declaration.connections));
  for (const declaration of Object.values(input.declaration.connections)) {
    if ('sharedRef' in declaration) continue;
    if (
      'deviceId' in declaration.config ||
      'deviceResourceId' in declaration.config ||
      'deviceResourceDigest' in declaration.config
    )
      throw new AppError('MANIFEST_EXTERNAL_MAPPING', '模板设备和本地资源必须使用外部逻辑映射');
    if (declaration.config.cwd !== undefined) directory.parse(declaration.config.cwd);
    for (const field of ['env', 'headers']) {
      const values = declaration.config[field];
      if (values && typeof values === 'object')
        for (const value of Object.values(values)) reference.parse(value);
    }
    const oauth = declaration.config.oauth as { clientSecret?: unknown } | undefined;
    if (oauth?.clientSecret !== undefined) reference.parse(oauth.clientSecret);
    const api = declaration.config.openapi as
      | { credentials?: Record<string, Record<string, unknown>> }
      | undefined;
    for (const credential of Object.values(api?.credentials ?? {}))
      for (const field of ['value', 'password', 'clientSecret'])
        if (credential[field] !== undefined) reference.parse(credential[field]);
    const config = validationValues(declaration.config) as Record<string, unknown>;
    connectionInput.parse({
      ...config,
      ...(declaration.deviceRef ? { deviceId: '00000000-0000-4000-8000-000000000001' } : {}),
    });
  }
  for (const profile of Object.values(input.declaration.profiles)) {
    const refs = [
      ...profile.tools,
      ...profile.content,
      ...profile.requestable.tools,
      ...profile.requestable.content,
    ].map((entry) => entry.connection);
    refs.push(
      ...Object.keys(profile.connectionAliases),
      ...Object.keys(profile.connectionIdentities),
    );
    if (refs.some((name) => !names.has(name)))
      throw new AppError('MANIFEST_REFERENCE', 'Profile 引用了声明中不存在的连接');
  }
  for (const share of Object.values(input.declaration.shares))
    if (
      !names.has(share.connection) ||
      'sharedRef' in input.declaration.connections[share.connection]!
    )
      throw new AppError('MANIFEST_REFERENCE', '共享授权必须引用声明中由当前账号管理的连接');
}
export function external<K extends keyof ManifestMappings>(
  mappings: ManifestMappings,
  kind: K,
  name: string,
) {
  const value = mappings[kind][name];
  if (!value) throw new DeploymentPending(`缺少外部映射：${kind}.${name}`);
  return value;
}
export async function connectionValues(
  declaration: Exclude<ManifestConnection, { sharedRef: string }>,
  input: {
    mappings: ManifestMappings;
    secret: (name: string) => Promise<string>;
    directory: (path: string) => Promise<void>;
  },
) {
  const config = (await resolveValues(declaration.config, {
    secret: input.secret,
    directory: async (name) => {
      const path = external(input.mappings, 'directories', name);
      if (declaration.config.adapter !== 'device') await input.directory(path);
      return path;
    },
  })) as Record<string, unknown>;
  return connectionInput.parse({
    ...config,
    ...(declaration.deviceRef
      ? { deviceId: external(input.mappings, 'devices', declaration.deviceRef) }
      : {}),
  });
}
