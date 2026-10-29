import { dirname, join, resolve } from 'node:path';
import { identifyPackage, type PackageCommand } from './sources.js';
type Files = { read: (path: string) => Promise<string | undefined>; home: string; cwd: string };
export async function npmDeclaration<T extends PackageCommand & { cwd?: string }>(
  input: T,
  files: Files,
) {
  const spec = identifyPackage(input);
  if (spec?.ecosystem !== 'npm') return { input, auth: {} as Record<string, string> };
  const env = input.env ?? {};
  const config = await readNpmConfiguration(input, files);
  const scope = spec.name.startsWith('@') ? spec.name.split('/')[0] : undefined;
  const scoped = scope ? config[`${scope}:registry`] : undefined;
  const next = {
    ...input,
    env: { ...(config.registry ? { npm_config_registry: config.registry } : {}), ...env },
  };
  // npm's scoped registry takes precedence over its general --registry option.
  const sourceProtected =
    spec.name.startsWith('@') &&
    Object.keys(
      npmAuthorization(scoped || config.registry || 'https://registry.npmjs.org/', config),
    ).length > 0;
  return { input: { ...next, scopedSource: scoped, sourceProtected }, auth: config };
}
function parseNpmrc(content: string | undefined, env: Record<string, string>) {
  const values: Record<string, string> = {};
  for (const line of (content ?? '').split(/\r?\n/)) {
    const match = /^\s*([^#;][^=]*?)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    const key = match[1]!;
    if (
      key !== 'registry' &&
      !key.endsWith(':registry') &&
      !/^\/\/.*:(?:_authToken|_auth|username|_password)$/.test(key)
    )
      continue;
    values[key] = match[2]!
      .replace(/^(['"])(.*)\1$/, '$2')
      .replace(/\$\{([^}]+)\}/g, (_, name: string) => {
        if (env[name] === undefined) throw new Error('npm 配置引用了未传入进程的环境变量');
        return env[name]!;
      });
  }
  return values;
}
export function npmAuthorization(
  source: string,
  config: Record<string, string>,
): Record<string, string> {
  const url = new URL(source);
  const keys = Object.keys(config)
    .filter((key) => key.startsWith(`//${url.host}/`) && key.endsWith(':_authToken'))
    .sort((a, b) => b.length - a.length);
  const token = keys.find((key) =>
    npmPathMatches(url.pathname, key.slice(`//${url.host}`.length, -':_authToken'.length)),
  );
  if (token) return { Authorization: `Bearer ${config[token]}` };
  const prefix = `//${url.host}${url.pathname.endsWith('/') ? url.pathname : url.pathname + '/'}:`;
  if (config[`${prefix}_auth`]) return { Authorization: `Basic ${config[`${prefix}_auth`]}` };
  if (config[`${prefix}username`] && config[`${prefix}_password`])
    return {
      Authorization: `Basic ${Buffer.from(`${config[`${prefix}username`]}:${Buffer.from(config[`${prefix}_password`]!, 'base64').toString()}`).toString('base64')}`,
    };
  return {};
}

async function readNpmConfiguration(input: PackageCommand & { cwd?: string }, files: Files) {
  const env = input.env ?? {};
  const home = env.HOME || files.home;
  const config: Record<string, string> = {};
  const global = env.npm_config_globalconfig || env.NPM_CONFIG_GLOBALCONFIG;
  if (global) Object.assign(config, parseNpmrc(await files.read(resolve(global)), env));
  Object.assign(
    config,
    parseNpmrc(
      await files.read(
        resolve(env.npm_config_userconfig || env.NPM_CONFIG_USERCONFIG || join(home, '.npmrc')),
      ),
      env,
    ),
  );
  Object.assign(config, await projectConfiguration(input.cwd || files.cwd, files.read, env));
  return config;
}

async function projectConfiguration(cwd: string, read: Files['read'], env: Record<string, string>) {
  let directory = resolve(cwd);
  while (true) {
    const content = await read(join(directory, '.npmrc'));
    if (content !== undefined) {
      return parseNpmrc(content, env);
    }
    const parent = dirname(directory);
    if (directory === parent) break;
    directory = parent;
  }
  return {};
}

function npmPathMatches(path: string, scope: string) {
  const root = scope.replace(/\/$/, '');
  return path === root || path.startsWith(root + '/');
}
