import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
const image = process.argv[2];
if (!image) throw new Error('Usage: node scripts/verify-python-runtime.mjs IMAGE');
const timeoutSeconds = Number(process.env.PYTHON_VERIFY_TIMEOUT_SECONDS ?? 60);
if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds <= 0)
  throw new Error('PYTHON_VERIFY_TIMEOUT_SECONDS must be a positive integer');
const volume = `platform-python-${randomUUID()}`;
function docker(args) {
  return execFileSync('docker', args, { stdio: 'inherit', timeout: (timeoutSeconds + 10) * 1000 });
}
docker(['volume', 'create', volume]);
try {
  for (const offline of [false, true]) {
    console.log(offline ? 'Hot cache, network disabled' : 'Cold cache, network enabled');
    docker([
      'run',
      '--rm',
      '--init',
      '--network',
      offline ? 'none' : 'bridge',
      '--mount',
      `type=volume,source=${volume},target=/app/.data`,
      '--mount',
      `type=bind,source=${resolve('tests/python-smoke.mts')},target=/app/tests/python-smoke.mts,readonly`,
      '-e',
      `PYTHON_VERIFY_TIMEOUT_SECONDS=${timeoutSeconds}`,
      '-e',
      `UV_OFFLINE=${offline}`,
      image,
      'node',
      'scripts/check.mjs',
      String(timeoutSeconds),
      'pnpm',
      'exec',
      'tsx',
      'tests/python-smoke.mts',
    ]);
  }
} finally {
  docker(['volume', 'rm', volume]);
}
