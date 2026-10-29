import { join, resolve } from 'node:path';
import { parse } from 'smol-toml';
import { identifyPackage, type PackageCommand } from './sources.js';
export async function pythonDeclaration<T extends PackageCommand>(
  input: T,
  files: { read: (path: string) => Promise<string | undefined>; home: string },
) {
  if (identifyPackage(input)?.ecosystem !== 'pypi' || input.args?.includes('--no-config'))
    return input;
  const env = input.env ?? {};
  const paths = configurationPaths(env, files.home);
  let configuration: Record<string, unknown> = {};
  for (const path of paths) {
    const content = await files.read(path);
    if (content === undefined) continue;
    const parsed = parse(content);
    configuration = {
      ...configuration,
      ...parsed,
      index: [
        ...(Array.isArray(parsed.index) ? parsed.index : []),
        ...(Array.isArray(configuration.index) ? configuration.index : []),
      ],
    };
  }
  return applyConfiguration(input, configuration);
}
function applyConfiguration<T extends PackageCommand>(
  input: T,
  configuration: Record<string, unknown>,
) {
  const env = input.env ?? {};
  const indexes = Array.isArray(configuration.index)
    ? (configuration.index as { url?: string; default?: boolean; explicit?: boolean }[])
    : [];
  const multiple = multipleIndexes(indexes, configuration, env);
  const declared =
    indexes.find((index) => index.default)?.url ||
    configuration['default-index'] ||
    configuration['index-url'];
  if (declared !== undefined && typeof declared !== 'string')
    throw new Error('Python 默认索引配置必须是 URL 字符串');
  return {
    ...input,
    sourceUncertain: multiple ? '配置了多个 Python 索引，无法证明单一包来源' : undefined,
    env: { ...(declared ? { UV_DEFAULT_INDEX: declared } : {}), ...env },
  };
}

function configurationPaths(env: Record<string, string>, fallbackHome: string) {
  const home = env.HOME || fallbackHome;
  const paths = env.UV_CONFIG_FILE
    ? [resolve(env.UV_CONFIG_FILE)]
    : [
        join(env.PROGRAMDATA || '/etc', 'uv', 'uv.toml'),
        join(env.APPDATA || env.XDG_CONFIG_HOME || join(home, '.config'), 'uv', 'uv.toml'),
      ];
  return paths;
}

function multipleIndexes(
  indexes: { default?: boolean; explicit?: boolean }[],
  configuration: Record<string, unknown>,
  env: Record<string, string>,
) {
  return (
    indexes.some((index) => !index.default && !index.explicit) ||
    Array.isArray(configuration['extra-index-url']) ||
    Boolean(env.UV_INDEX || env.UV_EXTRA_INDEX_URL)
  );
}
