import type { NetworkConfig } from '@platform/contracts';
export type PackageCommand = {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  packageSource?: string;
  registry?: { identifier?: string; packageVersion?: string; distribution?: string };
};
export type PackageSpec = {
  ecosystem: 'npm' | 'pypi';
  name: string;
  configured: string;
  source: string;
};
const NPM = 'https://registry.npmjs.org/';
const PYPI = 'https://pypi.org/simple/';
function runner(input: PackageCommand) {
  const command = input.command
    ?.split(/[\\/]/)
    .at(-1)
    ?.replace(/\.(exe|cmd)$/i, '');
  const args = [...(input.args ?? [])];
  if (command === 'npx') return { ecosystem: 'npm' as const, args };
  if (command === 'npm' && args.shift() === 'exec') return { ecosystem: 'npm' as const, args };
  if (command === 'uvx') return { ecosystem: 'pypi' as const, args };
  if (command === 'uv' && args.shift() === 'tool' && args.shift() === 'run')
    return { ecosystem: 'pypi' as const, args };
  return undefined;
}
export function identifyPackage(input: PackageCommand): Omit<PackageSpec, 'source'> | undefined {
  const run = runner(input);
  if (!run) return undefined;
  const { ecosystem, args } = run;
  const candidates: string[] = [];
  let positional: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--') {
      positional = args[i + 1];
      break;
    }
    if (['--package', '-p', '--from'].includes(arg)) {
      candidates.push(args[++i] ?? '');
      continue;
    }
    if (/^--(?:package|from)=/.test(arg)) {
      candidates.push(arg.slice(arg.indexOf('=') + 1));
      continue;
    }
    if (['--registry', '--index-url', '--default-index', '-i'].includes(arg)) {
      i++;
      continue;
    }
    if (
      /^--(?:registry|index-url|default-index)=/.test(arg) ||
      ['-y', '--yes', '--no-install', '--no-cache', '--refresh'].includes(arg)
    )
      continue;
    if (arg.startsWith('-')) return undefined;
    positional = arg;
    break;
  }
  if (candidates.length > 1) return undefined;
  const declared = candidates[0] ?? positional;
  if (!declared) return undefined;
  const pattern =
    ecosystem === 'npm'
      ? /^((?:@[\w.-]+\/)?[\w.-]+)(?:@([^\s/]+))?$/
      : /^([A-Za-z0-9][A-Za-z0-9._-]*)(?:(==|>=|~=|<=|>|<|!=)([\w.!+*,-]+))?$/;
  const match = pattern.exec(declared);
  if (!match) return undefined;
  const name = match[1]!;
  if (input.registry?.distribution === 'package' && input.registry.identifier !== name)
    return undefined;
  return {
    ecosystem,
    name,
    configured: ecosystem === 'npm' ? (match[2] ?? 'latest') : match[2] ? match[2] + match[3] : '*',
  };
}
function sourceArgument(args: string[], ecosystem: 'npm' | 'pypi') {
  const flags = ecosystem === 'npm' ? ['--registry'] : ['--index-url', '--default-index', '-i'];
  // Only runner arguments, never the MCP program's flags.
  let explicitPackage = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--') break;
    const flag = flags.find((flag) => arg === flag || arg.startsWith(`${flag}=`));
    if (flag)
      return {
        index: i,
        inline: arg !== flag,
        value: arg === flag ? args[i + 1] : arg.slice(flag.length + 1),
        flag,
      };
    if (['--package', '-p', '--from'].includes(arg)) {
      explicitPackage = true;
      i++;
      continue;
    }
    if (arg.startsWith('--package=') || arg.startsWith('--from=')) {
      explicitPackage = true;
      continue;
    }
    if (!arg.startsWith('-')) {
      if (!explicitPackage) break;
      break;
    }
  }
  return undefined;
}
export function resolvePackage(input: PackageCommand, config: NetworkConfig) {
  const spec = identifyPackage(input);
  if (!spec) return undefined;
  const run = runner(input)!;
  const argument = sourceArgument(run.args, spec.ecosystem);
  const env = input.env ?? {};
  const declared =
    argument?.value ||
    (spec.ecosystem === 'npm'
      ? env.npm_config_registry || env.NPM_CONFIG_REGISTRY
      : env.UV_DEFAULT_INDEX || env.UV_INDEX_URL || env.PIP_INDEX_URL);
  const original = declared || (spec.ecosystem === 'npm' ? NPM : PYPI);
  const url = new URL(original);
  const official =
    spec.ecosystem === 'npm'
      ? url.hostname === 'registry.npmjs.org'
      : ['pypi.org', 'pypi.python.org'].includes(url.hostname);
  const mirror = spec.ecosystem === 'npm' ? config.npmRegistry : config.pythonIndex;
  const source =
    input.packageSource ||
    (mirror && (!declared || (config.replacePublicSources && official)) ? mirror : original);
  const resolved = new URL(source);
  if (!['https:', 'http:'].includes(resolved.protocol) || resolved.hash)
    throw new Error('安装源必须是 HTTP(S) 地址');
  return { ...spec, source: resolved.href };
}
export function processNetwork(input: PackageCommand, config: NetworkConfig) {
  const env = { ...(input.env ?? {}) };
  for (const [key, endpoint, auth] of [
    ['HTTP_PROXY', config.httpProxy, config.secrets.httpProxyAuth],
    [
      'HTTPS_PROXY',
      config.httpsProxy || config.httpProxy,
      config.httpsProxy ? config.secrets.httpsProxyAuth : config.secrets.httpProxyAuth,
    ],
  ]) {
    if (!endpoint) continue;
    const url = new URL(endpoint);
    if (auth) {
      const separator = auth.indexOf(':');
      url.username = separator < 0 ? auth : auth.slice(0, separator);
      url.password = separator < 0 ? '' : auth.slice(separator + 1);
    }
    env[key!] = url.href;
    env[key!.toLowerCase()] = url.href;
  }
  if (config.noProxy) {
    env.NO_PROXY = config.noProxy;
    env.no_proxy = config.noProxy;
  }
  const spec = resolvePackage(input, config);
  const args = [...(input.args ?? [])];
  if (spec) {
    const run = runner(input)!;
    const found = sourceArgument(run.args, spec.ecosystem);
    const offset = args.length - run.args.length;
    if (found) {
      args[found.index + offset + (found.inline ? 0 : 1)] = found.inline
        ? `${found.flag}=${spec.source}`
        : spec.source;
    } else
      args.splice(offset, 0, spec.ecosystem === 'npm' ? '--registry' : '--index-url', spec.source);
    if (spec.ecosystem === 'npm') {
      env.npm_config_registry = spec.source;
      env.NPM_CONFIG_REGISTRY = spec.source;
    } else {
      env.UV_DEFAULT_INDEX = spec.source;
      env.UV_INDEX_URL = spec.source;
      env.PIP_INDEX_URL = spec.source;
    }
  }
  return { args, env, package: spec };
}
export function publicSource(source: string) {
  const url = new URL(source);
  url.username = '';
  url.password = '';
  url.search = '';
  url.hash = '';
  return url.href;
}
