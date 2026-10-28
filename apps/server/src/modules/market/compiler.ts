import {
  connectionInput,
  type RegistryPackage,
  type RegistryServer,
  type MarketSelection,
} from '@platform/contracts';
import { AppError } from '../../shared/errors.js';
import { argumentsFor, fieldValues, inputFields, namedValues, type MarketField } from './fields.js';
const PINNED_VERSION = /^[0-9][A-Za-z0-9.+_-]*$/;
export function packageSupport(pkg: RegistryPackage) {
  if (!['npm', 'pypi'].includes(pkg.registryType)) return `首版不支持 ${pkg.registryType} 包`;
  if (!pkg.version || !PINNED_VERSION.test(pkg.version)) return '包必须声明具体固定版本';
  if (!['stdio', 'streamable-http', 'sse'].includes(pkg.transport.type))
    return `不支持 ${pkg.transport.type} 传输`;
  if (pkg.runtimeHint && pkg.runtimeHint !== (pkg.registryType === 'npm' ? 'npx' : 'uvx'))
    return `首版不支持运行器 ${pkg.runtimeHint}`;
  const pattern =
    pkg.registryType === 'npm'
      ? /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i
      : /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
  return pattern.test(pkg.identifier) ? undefined : '包标识不是受支持的 npm/PyPI 包名';
}
export function distributionFields(
  server: RegistryServer,
  input: Pick<MarketSelection, 'distribution' | 'index'>,
): MarketField[] {
  if (input.distribution === 'remote') {
    const remote = server.remotes[input.index];
    if (!remote) throw new AppError('MARKET_DISTRIBUTION', '远程运行方式不存在');
    return [
      ...inputFields(remote.headers, 'headers'),
      ...Object.entries(remote.variables).map(([name, field]) => ({
        ...field,
        key: `url.${name}`,
        name,
      })),
    ];
  }
  const pkg = server.packages[input.index];
  if (!pkg) throw new AppError('MARKET_DISTRIBUTION', '包运行方式不存在');
  return [
    ...inputFields(pkg.runtimeArguments, 'runtime'),
    ...inputFields(pkg.packageArguments, 'args'),
    ...inputFields(pkg.environmentVariables, 'env'),
  ];
}
function packageUrl(pkg: RegistryPackage, input: MarketSelection) {
  if (!pkg.transport.url) throw new AppError('MARKET_URL', 'HTTP/SSE 包缺少连接地址');
  const fields = [
    ...pkg.packageArguments.map((field, index) => ({
      field,
      key: `args.${field.name ?? index}`,
      name: field.name ?? field.valueHint,
    })),
    ...pkg.environmentVariables.map((field) => ({
      field,
      key: `env.${field.name}`,
      name: field.name,
    })),
  ];
  return pkg.transport.url.replace(/\{([^{}]+)\}/g, (_, name: string) => {
    const item = fields.find((item) => item.name === name);
    if (!item) throw new AppError('MARKET_URL', `地址引用了未声明参数 ${name}`);
    const values = fieldValues(item.field, { key: item.key, values: input.values });
    if (values.length !== 1) throw new AppError('MARKET_URL', `地址参数 ${name} 需要一个明确值`);
    return encodeURIComponent(values[0]!);
  });
}
function packageConfig(server: RegistryServer, input: MarketSelection) {
  const pkg = server.packages[input.index]!;
  const unsupported = packageSupport(pkg);
  if (unsupported) throw new AppError('MARKET_UNSUPPORTED', unsupported);
  const runtime = argumentsFor(pkg.runtimeArguments, { prefix: 'runtime', values: input.values });
  const args = argumentsFor(pkg.packageArguments, { prefix: 'args', values: input.values });
  const registryUrl = pkg.registryBaseUrl ? new URL(pkg.registryBaseUrl) : undefined;
  if (
    registryUrl &&
    (!['http:', 'https:'].includes(registryUrl.protocol) ||
      registryUrl.username ||
      registryUrl.password)
  )
    throw new AppError('MARKET_REGISTRY_URL', '包仓库必须是无内嵌凭证的 HTTP(S) 地址');
  const npm = pkg.registryType === 'npm';
  const commandArgs = npm
    ? [
        ...runtime,
        '--yes',
        ...(registryUrl ? ['--registry', registryUrl.href] : []),
        ...(input.executable
          ? ['--package', `${pkg.identifier}@${pkg.version}`, '--', input.executable]
          : [`${pkg.identifier}@${pkg.version}`]),
        ...args,
      ]
    : [
        ...runtime,
        ...(registryUrl
          ? [
              '--index-url',
              new URL(
                registryUrl.pathname.endsWith('/simple') ||
                registryUrl.pathname.endsWith('/simple/')
                  ? registryUrl.href
                  : `${registryUrl.href.replace(/\/$/, '')}/simple/`,
              ).href,
            ]
          : []),
        '--from',
        `${pkg.identifier}==${pkg.version}`,
        input.executable ?? pkg.identifier,
        ...args,
      ];
  return {
    mode: 'managed',
    transport:
      pkg.transport.type === 'stdio' ? 'stdio' : pkg.transport.type === 'sse' ? 'sse' : 'http',
    ...(pkg.transport.type !== 'stdio' ? { url: packageUrl(pkg, input) } : {}),
    command: npm ? 'npx' : 'uvx',
    args: commandArgs,
    env: namedValues(pkg.environmentVariables, { prefix: 'env', values: input.values }),
  };
}
export function compileRegistry(server: RegistryServer, input: MarketSelection) {
  if (server.name !== input.serverName || server.version !== input.version)
    throw new AppError('MARKET_VERSION', '请选择具体服务器版本后预览');
  const fields = distributionFields(server, input);
  const allowed = new Set(fields.map((field) => field.key));
  if (Object.keys(input.values).some((key) => !allowed.has(key)))
    throw new AppError('MARKET_PARAMETER', '提交了所选运行方式未声明的参数');
  let config: Record<string, unknown>;
  if (input.distribution === 'package') config = packageConfig(server, input);
  else {
    const remote = server.remotes[input.index]!;
    if (!['streamable-http', 'sse'].includes(remote.type) || !remote.url)
      throw new AppError('MARKET_UNSUPPORTED', '远程服务必须声明 Streamable HTTP 或 SSE 地址');
    const url = remote.url.replace(/\{([^{}]+)\}/g, (_, name: string) => {
      const field = remote.variables[name];
      if (!field) throw new AppError('MARKET_URL', `地址引用了未声明变量 ${name}`);
      return encodeURIComponent(
        fieldValues(
          { ...field, isRequired: true },
          { key: `url.${name}`, values: input.values },
        )[0]!,
      );
    });
    config = {
      mode: 'existing',
      transport: remote.type === 'sse' ? 'sse' : 'http',
      url,
      headers: namedValues(remote.headers, { prefix: 'headers', values: input.values }),
    };
  }
  const secrets = fields
    .filter((field) => field.isSecret)
    .flatMap((field) => {
      const value = input.values[field.key];
      return value === undefined ? [] : Array.isArray(value) ? value : [value];
    })
    .filter(Boolean);
  const sensitiveArguments = Array.isArray(config.args)
    ? config.args.flatMap((arg: string, index: number) =>
        secrets.some((secret) => arg.includes(secret)) ? [index] : [],
      )
    : [];
  return connectionInput.parse({
    ...config,
    sensitiveArguments,
    name: input.name,
    adapter: input.adapter,
    deviceId: input.deviceId,
    registry: {
      provider: 'official-registry',
      serverName: server.name,
      version: server.version,
      distribution: input.distribution,
      index: input.index,
      ...(input.distribution === 'package'
        ? {
            identifier: server.packages[input.index]!.identifier,
            packageVersion: server.packages[input.index]!.version,
          }
        : {}),
    },
  });
}
