import type { NetworkConfig } from '@platform/contracts';
export function githubTarget(input: URL, config: NetworkConfig) {
  if (input.hostname === 'api.github.com' && config.githubApi) {
    const url = new URL(config.githubApi.replace(/\/$/, '') + input.pathname + input.search);
    return { url, token: config.secrets.githubApiToken };
  }
  if (
    [
      'github.com',
      'raw.githubusercontent.com',
      'objects.githubusercontent.com',
      'release-assets.githubusercontent.com',
    ].includes(input.hostname) &&
    config.githubDownload
  ) {
    const url = new URL(
      config.githubDownload
        .replace('{url}', input.href)
        .replace('{encodedUrl}', encodeURIComponent(input.href)),
    );
    return { url, token: config.secrets.githubDownloadToken };
  }
  return { url: input, token: undefined };
}
export function githubClone(input: string, config: NetworkConfig) {
  const url = new URL(input);
  if (url.hostname !== 'github.com' || !config.githubClone) return input;
  const match = /^\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url.pathname);
  if (!match || url.search || url.hash)
    throw new Error('GitHub 克隆地址必须指定 owner/repo；提交引用请单独传入');
  return config.githubClone.replaceAll('{owner}', match[1]!).replaceAll('{repo}', match[2]!);
}
export function stripCrossOriginHeaders(headers: Headers) {
  const names: string[] = [];
  headers.forEach((_, name) => names.push(name));
  for (const name of names) {
    if (
      ![
        'accept',
        'accept-language',
        'content-type',
        'user-agent',
        'if-none-match',
        'if-modified-since',
        'range',
      ].includes(name.toLowerCase())
    )
      headers.delete(name);
  }
}
