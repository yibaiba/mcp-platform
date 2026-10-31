// Prints the stdio sandbox status on this machine and, when usable, runs one wrapped command that
// checks the isolation. Used inside the image by verify-stdio-sandbox-image.mjs; also handy on a
// host: `pnpm exec tsx scripts/stdio-sandbox-check.mts`.
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { StdioSandbox } from '../apps/server/src/modules/mcp/stdioSandbox.js';
const dataDir = resolve(process.env.DATA_DIR ?? '.data');
const sandbox = new StdioSandbox({
  mode: 'bwrap',
  dataDir,
  bwrap: process.env.STDIO_SANDBOX_BWRAP,
});
const status = await sandbox.status();
const report: Record<string, unknown> = { arch: process.arch, status };
if (status.mode === 'bwrap' && status.ready) {
  const secret = join(dataDir, 'secrets', 'sandbox-check');
  await mkdir(join(dataDir, 'secrets'), { recursive: true });
  await writeFile(secret, 'secret');
  const script = [
    `test ! -e '${secret}' || { echo SECRET_VISIBLE; exit 1; }`,
    `touch /usr/sandbox-check 2>/dev/null && { echo ROOT_WRITABLE; exit 1; }`,
    `touch "$HOME/ok" || { echo HOME_NOT_WRITABLE; exit 1; }`,
    'echo ISOLATED',
  ].join('; ');
  const launch = await sandbox.wrap(
    { command: '/bin/sh', args: ['-c', script], env: {} },
    'image-check',
  );
  report.run = await new Promise((done) =>
    execFile(
      launch.command!,
      launch.args,
      { env: { PATH: process.env.PATH ?? '', ...launch.env }, timeout: 10_000, encoding: 'utf8' },
      (error, stdout, stderr) => done({ ok: !error, stdout: stdout.trim(), stderr: stderr.trim() }),
    ),
  );
}
console.log(JSON.stringify(report));
