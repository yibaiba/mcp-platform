import type { NetworkConfig } from '@platform/contracts';
import { identifyPackage, sourceArgument } from './runner.js';
export { identifyPackage } from './runner.js';
export { processNetwork } from './process.js';
export type PackageCommand = {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  packageSource?: string;
  scopedSource?: string;
  sourceUncertain?: string;
  sourceProtected?: boolean;
  registry?: { identifier?: string; packageVersion?: string; distribution?: string };
};
export type PackageSpec = {
  ecosystem: 'npm' | 'pypi';
  name: string;
  configured: string;
  source: string;
};
const defaults = { npm: 'https://registry.npmjs.org/', pypi: 'https://pypi.org/simple/' };
function declaredSource(input: PackageCommand, spec: Omit<PackageSpec, 'source'>) {
  const argument = sourceArgument(input, spec);
  if (argument?.flag.includes(':registry')) return argument.value;
  if (input.scopedSource) return input.scopedSource;
  if (argument?.value) return argument.value;
  const env = input.env ?? {};
  const keys =
    spec.ecosystem === 'npm'
      ? ['npm_config_registry', 'NPM_CONFIG_REGISTRY']
      : ['UV_DEFAULT_INDEX', 'UV_INDEX_URL', 'PIP_INDEX_URL'];
  return keys.map((key) => env[key]).find(Boolean);
}
function mirrorSource(
  input: { declared?: string; ecosystem: PackageSpec['ecosystem']; protected?: boolean },
  config: NetworkConfig,
) {
  const original = input.declared || defaults[input.ecosystem];
  const url = new URL(original);
  const official =
    input.ecosystem === 'npm'
      ? url.hostname === 'registry.npmjs.org'
      : ['pypi.org', 'pypi.python.org'].includes(url.hostname);
  const mirror = input.ecosystem === 'npm' ? config.npmRegistry : config.pythonIndex;
  if (!mirror || input.protected || authenticated(url)) return original;
  if (!input.declared || (config.replacePublicSources && official)) return mirror;
  return original;
}
export function resolvePackage(input: PackageCommand, config: NetworkConfig) {
  const spec = identifyPackage(input);
  if (!spec || input.sourceUncertain) return undefined;
  const source =
    input.packageSource ||
    mirrorSource(
      {
        declared: declaredSource(input, spec),
        ecosystem: spec.ecosystem,
        protected: input.sourceProtected,
      },
      config,
    );
  const resolved = new URL(source);
  if (!['https:', 'http:'].includes(resolved.protocol) || resolved.hash)
    throw new Error('安装源必须是 HTTP(S) 地址');
  return { ...spec, source: resolved.href };
}
export function publicSource(source: string) {
  const url = new URL(source);
  url.username = '';
  url.password = '';
  url.search = '';
  url.hash = '';
  return url.href;
}

function authenticated(url: URL) {
  return Boolean(url.username || url.password);
}
