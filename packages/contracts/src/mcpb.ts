import { z } from 'zod';
const launch = z
  .object({
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    env: z.record(z.string(), z.string()).default({}),
  })
  .strict();
const override = launch.partial();
const field = z
  .object({
    type: z.enum(['string', 'number', 'boolean', 'directory', 'file']),
    title: z.string().optional(),
    description: z.string().optional(),
    required: z.boolean().default(false),
    sensitive: z.boolean().default(false),
    multiple: z.boolean().default(false),
    default: z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]).optional(),
    min: z.number().optional(),
    max: z.number().optional(),
  })
  .strict();
export const mcpbManifest = z
  .object({
    manifest_version: z.enum(['0.1', '0.2', '0.3']),
    name: z.string().min(1),
    version: z.string().min(1),
    description: z.string().optional(),
    display_name: z.string().optional(),
    server: z
      .object({
        type: z.enum(['node', 'python', 'binary']),
        entry_point: z.string().min(1),
        mcp_config: launch.extend({
          platform_overrides: z
            .object({
              darwin: override.optional(),
              linux: override.optional(),
              win32: override.optional(),
            })
            .strict()
            .optional(),
        }),
      })
      .strict(),
    compatibility: z
      .object({
        platforms: z.array(z.enum(['darwin', 'linux', 'win32'])).optional(),
        runtimes: z.record(z.string(), z.string()).optional(),
      })
      .passthrough()
      .optional(),
    user_config: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), field).default({}),
  })
  .passthrough();
export type McpbManifest = z.infer<typeof mcpbManifest>;
export type BundleEnvironment = {
  platform: 'darwin' | 'linux' | 'win32';
  home: string;
  root: string;
};
export type BundleLaunch = {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  sensitiveArguments: number[];
};
export function compileBundle(input: {
  manifest: McpbManifest;
  environment: BundleEnvironment;
  values: Record<string, unknown>;
  redact?: boolean;
}): BundleLaunch {
  const { manifest: m, environment: e } = input;
  if (m.compatibility?.platforms && !m.compatibility.platforms.includes(e.platform))
    throw new Error('扩展包不支持目标操作系统');
  const vars: Record<string, string | string[]> = {
    __dirname: e.root,
    HOME: e.home,
    DESKTOP: `${e.home}/Desktop`,
    DOCUMENTS: `${e.home}/Documents`,
    DOWNLOADS: `${e.home}/Downloads`,
    pathSeparator: e.platform === 'win32' ? '\\' : '/',
    '/': e.platform === 'win32' ? '\\' : '/',
  };
  const sensitive = new Set<string>();
  for (const name of Object.keys(input.values))
    if (!Object.hasOwn(m.user_config, name)) throw new Error(`未知配置项：${name}`);
  for (const [name, rule] of Object.entries(m.user_config)) {
    const supplied = Object.hasOwn(input.values, name);
    let value = supplied ? input.values[name] : rule.default;
    if (!supplied && typeof value === 'string') value = expandDefault(value, vars);
    if (!supplied && Array.isArray(value)) value = value.map((v) => expandDefault(v, vars));
    if (value === undefined || value === '') {
      if (rule.required) throw new Error(`缺少必填配置：${name}`);
      vars[`user_config.${name}`] = '';
      continue;
    }
    checkValue(name, rule, value);
    if (rule.sensitive) sensitive.add(`user_config.${name}`);
    const mapped = Array.isArray(value) ? (value as string[]) : String(value);
    vars[`user_config.${name}`] =
      input.redact && rule.sensitive
        ? Array.isArray(mapped)
          ? mapped.map(() => '••••••')
          : '••••••'
        : mapped;
  }
  const base = m.server.mcp_config,
    patch = base.platform_overrides?.[e.platform];
  const config = { ...base, ...patch, env: { ...base.env, ...patch?.env } };
  const expand = (value: string) =>
    value.replace(/\$\{([^}]+)\}/g, (_, key: string) => {
      if (!Object.hasOwn(vars, key)) throw new Error(`不支持的变量：${key}`);
      const result = vars[key];
      if (Array.isArray(result)) throw new Error(`多值配置 ${key} 必须单独作为一个参数`);
      return result!;
    });
  const args: string[] = [],
    sensitiveArguments: number[] = [];
  for (const arg of config.args) {
    const key = /^\$\{([^}]+)\}$/.exec(arg)?.[1];
    const values = key && Array.isArray(vars[key]) ? (vars[key] as string[]) : [expand(arg)];
    for (const value of values) {
      if ([...sensitive].some((name) => arg.includes('${' + name + '}')))
        sensitiveArguments.push(args.length);
      args.push(value);
    }
  }
  if ([...sensitive].some((name) => config.command.includes('${' + name + '}')))
    throw new Error('敏感配置不能用于可执行文件名称，请使用参数或环境变量');
  let command = expand(config.command);
  if (m.server.type === 'binary' && !/^(?:[A-Za-z]:[\\/]|\/)/.test(command))
    command = `${e.root}/${command}`;
  if (
    m.server.type === 'binary' &&
    e.platform === 'win32' &&
    !command.toLowerCase().endsWith('.exe')
  )
    command += '.exe';
  return {
    command,
    args,
    env: Object.fromEntries(Object.entries(config.env).map(([key, value]) => [key, expand(value)])),
    cwd: e.root,
    sensitiveArguments,
  };
}
function checkValue(name: string, rule: z.infer<typeof field>, value: unknown) {
  if (rule.multiple) {
    if (
      !['directory', 'file'].includes(rule.type) ||
      !Array.isArray(value) ||
      value.some((v) => typeof v !== 'string')
    )
      throw new Error(`${name} 必须是路径数组`);
    return;
  }
  const type = ['file', 'directory'].includes(rule.type) ? 'string' : rule.type;
  if (typeof value !== type) throw new Error(`${name} 类型不正确`);
  if (
    typeof value === 'number' &&
    (!Number.isFinite(value) ||
      (rule.min !== undefined && value < rule.min) ||
      (rule.max !== undefined && value > rule.max))
  )
    throw new Error(`${name} 超出声明范围`);
}

function expandDefault(value: string, vars: Record<string, string | string[]>) {
  return value.replace(/\$\{([^}]+)\}/g, (_, key: string) => {
    if (
      key.startsWith('user_config.') ||
      !Object.hasOwn(vars, key) ||
      typeof vars[key] !== 'string'
    )
      throw new Error(`默认值不支持变量：${key}`);
    return vars[key] as string;
  });
}
