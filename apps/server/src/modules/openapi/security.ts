import type { ConnectionInput } from '@platform/contracts';
import type { Operation } from './types.js';
import { AppError } from '../../shared/errors.js';
type Credentials = NonNullable<ConnectionInput['openapi']>['credentials'];
export async function applySecurity(input: {
  operation: Operation;
  choice?: number;
  credentials: Credentials;
  url: URL;
  headers: Headers;
  token: (name: string, scopes: string[]) => Promise<string>;
}) {
  const choices = input.operation.security;
  if (!choices.length) return;
  if (choices.length > 1 && input.choice === undefined)
    throw new AppError('OPENAPI_SECURITY_CHOICE', '请在连接配置中明确选择此操作的 OR 认证方案');
  const requirement = choices[input.choice ?? 0];
  if (!requirement) throw new AppError('OPENAPI_SECURITY_CHOICE', '认证方案索引无效');
  for (const [name, scopes] of Object.entries(requirement)) {
    const scheme = input.operation.schemes[name]!;
    const credential = input.credentials[name];
    if (!credential)
      throw new AppError('OPENAPI_CREDENTIAL_REQUIRED', `认证 ${name} 尚未配置`, 401);
    if (scheme.type === 'oauth2' || scheme.type === 'openIdConnect') {
      input.headers.set('Authorization', `Bearer ${await input.token(name, scopes)}`);
      continue;
    }
    if (scheme.type === 'http') {
      if (scheme.scheme === 'basic') {
        if (credential.username === undefined || credential.password === undefined)
          throw new AppError(
            'OPENAPI_CREDENTIAL_REQUIRED',
            `Basic 认证 ${name} 缺少用户名或密码`,
            401,
          );
        input.headers.set(
          'Authorization',
          `Basic ${Buffer.from(`${credential.username}:${credential.password}`).toString('base64')}`,
        );
      } else input.headers.set('Authorization', `Bearer ${required(credential.value, name)}`);
      continue;
    }
    const value = required(credential.value, name);
    if (scheme.in === 'query') input.url.searchParams.append(scheme.name!, value);
    else if (scheme.in === 'header') input.headers.set(scheme.name!, value);
    else if (scheme.in === 'cookie')
      input.headers.set(
        'Cookie',
        [
          input.headers.get('Cookie'),
          `${encodeURIComponent(scheme.name!)}=${encodeURIComponent(value)}`,
        ]
          .filter(Boolean)
          .join('; '),
      );
    else throw new AppError('OPENAPI_SECURITY', `API Key ${name} 的位置不受支持`);
  }
}
function required(value: string | undefined, name: string) {
  if (value === undefined)
    throw new AppError('OPENAPI_CREDENTIAL_REQUIRED', `认证 ${name} 缺少凭证`, 401);
  return value;
}
