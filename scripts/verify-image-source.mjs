import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);

export async function verifyImageSource(image, cwd) {
  const options = { cwd, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 };
  const { stdout } = await execute(
    'git',
    [
      'ls-files',
      '--cached',
      '--others',
      '--exclude-standard',
      '-z',
      '--',
      'apps/server/src',
      'apps/web/src',
      'packages',
      'integrations/pi/src',
    ],
    options,
  );
  const paths = stdout.split('\0').filter(Boolean).sort();
  assert.ok(paths.length, 'Repository source files must be available for image verification');
  const digest = createHash('sha256');
  for (const path of paths) digest.update(path).update(await readFile(resolve(cwd, path)));
  const script = `
    import { createHash } from 'node:crypto';
    import { readFileSync } from 'node:fs';
    const hash = createHash('sha256');
    for (const path of process.argv.slice(1)) hash.update(path).update(readFileSync(path));
    console.log(hash.digest('hex'));
  `;
  const actual = await execute(
    'docker',
    [
      'run',
      '--rm',
      '--network',
      'none',
      '--entrypoint',
      'node',
      image,
      '--input-type=module',
      '-e',
      script,
      ...paths,
    ],
    options,
  );
  assert.equal(
    actual.stdout.trim(),
    digest.digest('hex'),
    'Image source must match this workspace',
  );
  const source = await execute(
    'docker',
    [
      'image',
      'inspect',
      '--format',
      '{{ index .Config.Labels "org.opencontainers.image.source" }}',
      image,
    ],
    options,
  );
  assert.equal(source.stdout.trim(), 'https://github.com/yibaiba/mcp-platform');
  console.log('PASS: packaged server, web, shared packages and Pi sources match mcp-platform');
}
