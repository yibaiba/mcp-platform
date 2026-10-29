import type { PackageCommand, PackageSpec } from './sources.js';
type Ecosystem = PackageSpec['ecosystem'];
type SourceArgument = { index: number; inline: boolean; value?: string; flag: string };
const runners: Record<string, { ecosystem: Ecosystem; prefix: string[] }> = {
  npx: { ecosystem: 'npm', prefix: [] },
  npm: { ecosystem: 'npm', prefix: ['exec'] },
  uvx: { ecosystem: 'pypi', prefix: [] },
  uv: { ecosystem: 'pypi', prefix: ['tool', 'run'] },
};
const packageFlags = new Set(['--package', '-p', '--from']);
const sourceFlags = new Set(['--registry', '--index-url', '--default-index', '-i']);
const switches = new Set(['-y', '--yes', '--no-install', '--no-cache', '--refresh', '--no-config']);
export function runner(input: PackageCommand) {
  const command = (input.command ?? '')
    .split(/[\\/]/)
    .at(-1)!
    .replace(/\.(exe|cmd)$/i, '');
  const definition = runners[command];
  if (!definition) return undefined;
  const args = input.args ?? [];
  const offset = definition.prefix.length;
  if (args.slice(0, offset).join(' ') !== definition.prefix.join(' ')) return undefined;
  return {
    ecosystem: definition.ecosystem,
    args: args.slice(offset),
    offset,
    interspersed: command === 'npm',
  };
}
function argumentAt(args: string[], index: number): SourceArgument {
  const arg = args[index]!;
  const separator = arg.indexOf('=');
  return separator < 0
    ? { index, inline: false, flag: arg, value: args[index + 1] }
    : { index, inline: true, flag: arg.slice(0, separator), value: arg.slice(separator + 1) };
}
function isSource(flag: string) {
  return sourceFlags.has(flag) || /^--@[\w.-]+:registry$/.test(flag);
}
function recordOption(
  value: SourceArgument,
  state: { candidates: string[]; sources: Map<string, SourceArgument> },
) {
  if (packageFlags.has(value.flag)) state.candidates.push(value.value ?? '');
  else if (isSource(value.flag)) state.sources.set(value.flag, value);
  else return false;
  return true;
}
function argumentsFor(args: string[], interspersed: boolean) {
  const candidates: string[] = [];
  const sources = new Map<string, SourceArgument>();
  let positional: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === '--') {
      positional ??= args[index + 1];
      break;
    }
    if (!arg.startsWith('-')) {
      positional ??= arg;
      if (!interspersed) break;
      continue;
    }
    if (switches.has(arg)) continue;
    const value = argumentAt(args, index);
    if (!recordOption(value, { candidates, sources })) return undefined;
    if (!value.inline) index++;
  }
  return { candidates, positional, sources };
}
export function identifyPackage(input: PackageCommand): Omit<PackageSpec, 'source'> | undefined {
  const run = runner(input);
  if (!run) return undefined;
  const args = argumentsFor(run.args, run.interspersed);
  if (!args || args.candidates.length > 1) return undefined;
  const declared = args.candidates[0] ?? args.positional;
  if (!declared) return undefined;
  const spec = packageDeclaration(declared, run.ecosystem);
  if (input.registry?.distribution === 'package' && input.registry.identifier !== spec?.name)
    return undefined;
  return spec;
}
function packageDeclaration(declared: string, ecosystem: Ecosystem) {
  const pattern =
    ecosystem === 'npm'
      ? /^((?:@[\w.-]+\/)?[\w.-]+)(?:@([^\s/]+))?$/
      : /^([A-Za-z0-9][A-Za-z0-9._-]*)(?:(==|>=|~=|<=|>|<|!=)([\w.!+*,-]+))?$/;
  const match = pattern.exec(declared);
  if (!match) return undefined;
  const configured =
    ecosystem === 'npm' ? (match[2] ?? 'latest') : match[2] ? match[2] + match[3] : '*';
  return { ecosystem, name: match[1]!, configured };
}
export function sourceArgument(input: PackageCommand, spec: Omit<PackageSpec, 'source'>) {
  const run = runner(input);
  if (!run) return undefined;
  const sources = argumentsFor(run.args, run.interspersed)?.sources;
  if (!sources) return undefined;
  const scoped = sources.get(`--${spec.name.split('/')[0]}:registry`);
  if (spec.ecosystem === 'npm') return scoped ?? sources.get('--registry');
  return [...sources.values()].filter((arg) => sourceFlags.has(arg.flag)).at(-1);
}
