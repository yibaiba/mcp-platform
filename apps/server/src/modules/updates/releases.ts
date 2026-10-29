import { z } from 'zod';
import semver from 'semver';
export const releaseSchema = z.object({
  tag_name: z.string(),
  draft: z.boolean(),
  prerelease: z.boolean(),
  published_at: z.string().nullable(),
  body: z.string().nullable(),
  html_url: z.url().refine((value) => {
    const url = new URL(value);
    return (
      url.origin === 'https://github.com' &&
      url.pathname.startsWith('/yibaiba/mcp-platform/releases/')
    );
  }),
});
export type Release = z.infer<typeof releaseSchema>;
export type ReleaseCache = Record<
  string,
  { etag: string | null; modified: string | null; releases: Release[]; next: string | null }
>;
export class ReleaseError extends Error {
  constructor(
    readonly state: 'failed' | 'rate_limited',
    message: string,
  ) {
    super(message);
  }
}
const ENDPOINT = 'https://api.github.com/repos/yibaiba/mcp-platform/releases?per_page=100';
export async function queryReleases(fetch: typeof globalThis.fetch, previous: ReleaseCache) {
  const cache: ReleaseCache = {};
  const releases: Release[] = [];
  let url: string | null = ENDPOINT;
  const visited = new Set<string>();
  while (url) {
    if (visited.has(url)) throw new ReleaseError('failed', 'GitHub 分页地址重复');
    visited.add(url);
    const page = await releasePage(fetch, { url, cached: previous[url] });
    cache[url] = page;
    releases.push(...page.releases);
    url = page.next;
  }
  const stable = releases.filter(
    (release) =>
      !release.draft &&
      !release.prerelease &&
      semver.valid(release.tag_name) &&
      !semver.prerelease(release.tag_name),
  );
  stable.sort((a, b) => semver.rcompare(a.tag_name, b.tag_name));
  return { release: stable[0] ?? null, cache };
}
async function releasePage(
  fetch: typeof globalThis.fetch,
  input: { url: string; cached?: ReleaseCache[string] },
): Promise<ReleaseCache[string]> {
  const headers = conditionalHeaders(input.cached);
  const response = await fetch(input.url, { headers, signal: AbortSignal.timeout(15_000) });
  if (response.status === 304 && input.cached) return input.cached;
  await validateResponse(response);
  const releases = z.array(releaseSchema).parse(await response.json());
  const next = nextPage(response, input.url);
  return {
    releases,
    next,
    etag: response.headers.get('etag'),
    modified: response.headers.get('last-modified'),
  };
}

function conditionalHeaders(cached?: ReleaseCache[string]) {
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json' };
  if (cached?.etag) headers['If-None-Match'] = cached.etag;
  else if (cached?.modified) headers['If-Modified-Since'] = cached.modified;
  return headers;
}

async function validateResponse(response: Response) {
  if (response.status === 403 || response.status === 429) {
    const limited =
      response.status === 429 ||
      response.headers.get('x-ratelimit-remaining') === '0' ||
      response.headers.has('retry-after');
    await response.body?.cancel();
    throw new ReleaseError(
      limited ? 'rate_limited' : 'failed',
      limited ? 'GitHub 请求受到限流，请稍后手动检查' : 'GitHub 拒绝请求，请检查端点和独立凭证',
    );
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new ReleaseError('failed', `GitHub Release 查询返回 HTTP ${response.status}`);
  }
}

function nextPage(response: Response, originalURL: string) {
  const link = /<([^>]+)>;\s*rel="next"/.exec(response.headers.get('link') ?? '')?.[1];
  let next: string | null = null;
  if (link) {
    const actual = new URL(response.url || originalURL);
    const candidate = new URL(link, actual);
    const original = new URL(originalURL);
    const recognized = sameEndpoint(candidate, original) || sameEndpoint(candidate, actual);
    if (!recognized || candidate.username || candidate.password || candidate.hash)
      throw new ReleaseError('failed', 'GitHub 返回了无效的分页地址');
    original.search = candidate.search;
    next = original.href;
  }
  return next;
}

function sameEndpoint(a: URL, b: URL) {
  return a.origin === b.origin && a.pathname === b.pathname;
}
