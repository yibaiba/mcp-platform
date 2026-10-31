import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { expect, test } from 'vitest';

/**
 * Old words that docs/glossary.md retired. They must not come back in strings users or
 * external agents see (server messages, tool descriptions, web copy). The glossary itself
 * lists them as "旧叫法" and is the only allowed place.
 */
const retired = ['平台主机', '执行位置', '工具目录', '上游授权', '执行适配器', '平台直连'];
const root = new URL('..', import.meta.url).pathname;
const allowed = new Set(['apps/web/src/features/onboarding/glossary.ts']);

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.(ts|tsx)$/.test(name) && !name.endsWith('.gen.ts') ? [path] : [];
  });
}

test('retired glossary terms do not appear in server, web or contract source', () => {
  const hits: string[] = [];
  for (const dir of ['apps/server/src', 'apps/web/src', 'packages/contracts/src']) {
    for (const path of files(join(root, dir))) {
      const rel = relative(root, path);
      if (allowed.has(rel)) continue;
      readFileSync(path, 'utf8')
        .split('\n')
        .forEach((line, index) => {
          for (const word of retired)
            if (line.includes(word)) hits.push(`${rel}:${index + 1} ${word}`);
        });
    }
  }
  expect(hits).toEqual([]);
});
