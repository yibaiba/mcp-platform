// Checks the optional stdio sandbox inside the packaged image on this runner's architecture.
// usage: node scripts/verify-stdio-sandbox-image.mjs IMAGE default|unconfined
//  default    — plain `docker run` (default seccomp/AppArmor): bwrap must be installed; the
//               sandbox may be refused, but then with an explicit error and hint (never silent).
//  unconfined — the documented options (seccomp=unconfined, apparmor=unconfined): the sandbox
//               must be ready and the wrapped command isolated.
import { execFileSync } from 'node:child_process';
const [image, variant] = process.argv.slice(2);
if (!image || !['default', 'unconfined'].includes(variant))
  throw new Error('Usage: node scripts/verify-stdio-sandbox-image.mjs IMAGE default|unconfined');
const docker = (args) =>
  execFileSync('docker', args, { encoding: 'utf8', timeout: 120_000 }).trim();
const version = docker(['run', '--rm', '--entrypoint', 'bwrap', image, '--version']);
console.log(`bwrap in image: ${version}`);
if (!/^bubblewrap \d+\.\d+/.test(version)) throw new Error('bubblewrap missing from the image');
const options =
  variant === 'unconfined'
    ? ['--security-opt', 'seccomp=unconfined', '--security-opt', 'apparmor=unconfined']
    : [];
const output = docker([
  'run',
  '--rm',
  '--init',
  ...options,
  image,
  'pnpm',
  '--silent',
  'exec',
  'tsx',
  'scripts/stdio-sandbox-check.mts',
]);
const line = output
  .split('\n')
  .filter((entry) => entry.startsWith('{'))
  .at(-1);
if (!line) throw new Error(`no report from the image:\n${output}`);
const report = JSON.parse(line);
console.log(JSON.stringify(report, null, 2));
const { status } = report;
if (status.ready) {
  if (!report.run?.ok || report.run.stdout !== 'ISOLATED')
    throw new Error(`sandbox ready but the isolation check failed: ${JSON.stringify(report.run)}`);
} else {
  if (variant === 'unconfined')
    throw new Error(`sandbox not usable with the documented options: ${status.error}`);
  if (!status.error || !status.hint) throw new Error('sandbox refused without an error and hint');
}
console.log(
  `${variant}: ${status.ready ? `ready (/proc ${status.proc}), isolated` : `refused: ${status.error} — ${status.hint}`}`,
);
