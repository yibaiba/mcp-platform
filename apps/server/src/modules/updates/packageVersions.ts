import { z } from 'zod';
import semver from 'semver';
import * as pep440 from '@renovatebot/pep440';
import type { PackageSpec } from '@platform/network';
export function latestStable(ecosystem: PackageSpec['ecosystem'], versions: string[]) {
  const stable = versions.filter((version) =>
    ecosystem === 'npm'
      ? Boolean(semver.valid(version)) && !semver.prerelease(version)
      : Boolean(pep440.valid(version)) &&
        !pep440.parse(version)?.is_prerelease &&
        !pep440.parse(version)?.is_devrelease &&
        !pep440.parse(version)?.local,
  );
  return (
    stable.sort((a, b) =>
      ecosystem === 'npm' ? semver.rcompare(a, b) : pep440.rcompare(a, b),
    )[0] ?? null
  );
}
export function newerThanConfigured(spec: PackageSpec, latest: string | null) {
  if (!latest) return null;
  if (spec.ecosystem === 'npm')
    return semver.valid(spec.configured) ? semver.gt(latest, spec.configured) : null;
  const pinned = spec.configured.startsWith('==') ? spec.configured.slice(2) : '';
  return pep440.valid(pinned) ? pep440.gt(latest, pinned) : null;
}
export function pythonVersions(text: string, contentType: string) {
  const names = contentType.includes('json')
    ? z
        .object({
          files: z.array(
            z.object({
              filename: z.string(),
              yanked: z.union([z.boolean(), z.string()]).optional(),
            }),
          ),
        })
        .parse(JSON.parse(text))
        .files.filter((file) => file.yanked === undefined || file.yanked === false)
        .map((file) => file.filename)
    : [...text.matchAll(/<a\s[^>]*href=["']([^"']+)["'][^>]*>/gi)]
        .filter((match) => !/data-yanked(?:\s|=|>)/i.test(match[0]))
        .map((match) => decodeURIComponent(match[1]!.split(/[?#]/)[0]!.split('/').at(-1)!));
  return [
    ...new Set(
      names.flatMap((filename) => {
        const wheel = /^[^-]+-([^-]+)-.+\.whl$/.exec(filename);
        if (wheel) return [wheel[1]!];
        const archive = /-([0-9][^-]*)\.(?:tar\.gz|tar\.bz2|tar\.xz|zip|tgz)$/.exec(filename);
        return archive ? [archive[1]!] : [];
      }),
    ),
  ];
}
export async function queryPackage(spec: PackageSpec, fetch: typeof globalThis.fetch) {
  const root = new URL(spec.source.endsWith('/') ? spec.source : `${spec.source}/`);
  const headers: Record<string, string> = {
    Accept:
      spec.ecosystem === 'npm'
        ? 'application/json'
        : 'application/vnd.pypi.simple.v1+json, text/html;q=0.9',
  };
  if (root.username || root.password) {
    headers.Authorization = `Basic ${Buffer.from(`${decodeURIComponent(root.username)}:${decodeURIComponent(root.password)}`).toString('base64')}`;
    root.username = '';
    root.password = '';
  }
  const name =
    spec.ecosystem === 'npm'
      ? encodeURIComponent(spec.name)
      : spec.name.toLowerCase().replace(/[-_.]+/g, '-') + '/';
  const response = await fetch(new URL(name, root), {
    headers,
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`包源查询返回 HTTP ${response.status}`);
  }
  if (spec.ecosystem === 'npm') {
    const data = z
      .object({ versions: z.record(z.string(), z.unknown()) })
      .parse(await response.json());
    return Object.keys(data.versions);
  }
  return pythonVersions(await response.text(), response.headers.get('content-type') ?? '');
}
