import {
  connectionInput,
  type ConnectorAuthentication,
  type ConnectorPreset,
} from '@platform/contracts';

export function presetConnection(options: {
  readonly preset: ConnectorPreset;
  readonly name: string;
  readonly adapter?: 'direct' | 'pi';
  readonly transport?: 'http' | 'stdio';
  readonly authentication: ConnectorAuthentication;
  readonly token?: string;
  readonly clientId?: string;
  readonly clientSecret?: string;
}) {
  const { preset, authentication } = options;
  if (!preset.authentication.includes(authentication)) throw new Error('此预设不支持所选认证方式');
  const token = options.token?.trim();
  if (authentication === 'bearer' && (!token || /[\r\n]/.test(token)))
    throw new Error('请填写有效的 Token / API Key，不可包含换行');
  const registeredOAuth = authentication === 'oauth' && preset.oauthRegistration;
  const stdio = options.transport === 'stdio' ? preset.stdio : undefined;
  if (options.transport === 'stdio' && !stdio) throw new Error('此预设不支持本地 stdio 连接');
  if (registeredOAuth && (!options.clientId?.trim() || !options.clientSecret?.trim()))
    throw new Error('GitHub OAuth 需要已注册应用的 Client ID 和 Client Secret');
  return connectionInput.parse({
    name: options.name,
    adapter: options.adapter ?? 'direct',
    ...(stdio
      ? {
          transport: 'stdio',
          mode: 'managed',
          command: stdio.command,
          args: [...stdio.args],
          env: { [stdio.tokenEnv]: token },
          credentialEnv: [stdio.tokenEnv],
        }
      : {
          transport: 'http',
          mode: 'existing',
          url: preset.url,
          headers: authentication === 'bearer' ? { Authorization: `Bearer ${token}` } : {},
          credentialHeaders: authentication === 'bearer' ? ['Authorization'] : [],
        }),
    oauth: registeredOAuth
      ? {
          clientId: options.clientId?.trim(),
          clientSecret: options.clientSecret?.trim(),
          tokenEndpointAuthMethod: 'client_secret_post',
        }
      : undefined,
  });
}
