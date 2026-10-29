import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
const destination = new URL('../.build-info.json', import.meta.url);
let commit = process.env.PLATFORM_COMMIT || process.env.GITHUB_SHA;
if (!commit && existsSync(new URL('../.git', import.meta.url)))
  commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 10_000 }).trim();
if (!commit && existsSync(destination))
  commit = JSON.parse(readFileSync(destination, 'utf8')).commit;
if (!commit || !/^[0-9a-f]{40}$/.test(commit))
  throw new Error('Build requires PLATFORM_COMMIT (full Git SHA) when Git metadata is unavailable');
const tag = process.env.PLATFORM_RELEASE_TAG || '';
if (tag && !/^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(tag))
  throw new Error('Invalid platform release tag');
const info = {
  version: tag || 'dev',
  commit,
  builtAt: new Date().toISOString(),
  release: Boolean(tag),
};
writeFileSync(destination, JSON.stringify(info) + '\n');
console.log(`Platform build: ${info.version} ${commit.slice(0, 8)}`);
