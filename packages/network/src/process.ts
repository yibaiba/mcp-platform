import type { NetworkConfig } from '@platform/contracts';
import { resolvePackage, type PackageCommand, type PackageSpec } from './sources.js';
import { runner, sourceArgument } from './runner.js';
function proxyURL(endpoint: string, auth?: string) {
  const url = new URL(endpoint);
  if (auth) {
    const separator = auth.indexOf(':');
    url.username = separator < 0 ? auth : auth.slice(0, separator);
    url.password = separator < 0 ? '' : auth.slice(separator + 1);
  }
  return url.href;
}
function proxyEnvironment(config: NetworkConfig) {
  const env: Record<string, string> = {};
  const httpsAuth = config.httpsProxy
    ? config.secrets.httpsProxyAuth
    : config.secrets.httpProxyAuth;
  const proxies = [
    ['HTTP_PROXY', config.httpProxy, config.secrets.httpProxyAuth],
    ['HTTPS_PROXY', config.httpsProxy || config.httpProxy, httpsAuth],
  ] as const;
  for (const [key, endpoint, auth] of proxies) {
    if (!endpoint) continue;
    env[key] = proxyURL(endpoint, auth);
    env[key.toLowerCase()] = env[key]!;
  }
  if (config.noProxy) {
    env.NO_PROXY = config.noProxy;
    env.no_proxy = config.noProxy;
  }
  return env;
}
function packageArguments(input: PackageCommand, spec: PackageSpec) {
  const args = [...(input.args ?? [])];
  const offset = runner(input)!.offset;
  const found = sourceArgument(input, spec);
  if (found)
    args[found.index + offset + (found.inline ? 0 : 1)] = found.inline
      ? `${found.flag}=${spec.source}`
      : spec.source;
  else args.splice(offset, 0, spec.ecosystem === 'npm' ? '--registry' : '--index-url', spec.source);
  const scoped = scopedArgument(input, spec, found?.flag);
  if (scoped) args.splice(offset, 0, scoped);
  return args;
}
function packageEnvironment(spec: PackageSpec) {
  const keys =
    spec.ecosystem === 'npm'
      ? ['npm_config_registry', 'NPM_CONFIG_REGISTRY']
      : ['UV_DEFAULT_INDEX', 'UV_INDEX_URL', 'PIP_INDEX_URL'];
  return Object.fromEntries(keys.map((key) => [key, spec.source]));
}
export function processNetwork(input: PackageCommand, config: NetworkConfig) {
  const env = { ...(input.env ?? {}), ...proxyEnvironment(config) };
  const spec = resolvePackage(input, config);
  if (!spec) return { args: [...(input.args ?? [])], env, package: spec };
  return {
    args: packageArguments(input, spec),
    env: { ...env, ...packageEnvironment(spec) },
    package: spec,
  };
}

function scopedArgument(input: PackageCommand, spec: PackageSpec, flag?: string) {
  const scoped = spec.ecosystem === 'npm' && spec.name.startsWith('@');
  if (scoped && (input.packageSource || input.scopedSource) && !flag?.includes(':registry'))
    return `--${spec.name.split('/')[0]}:registry=${spec.source}`;
  return undefined;
}
