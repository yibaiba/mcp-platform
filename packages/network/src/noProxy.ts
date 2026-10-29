import { isIP } from 'node:net';
// Match host or domain suffix on label boundaries; IPv6 literals require brackets when a port is used.
export function bypassProxy(url: URL, value: string) {
  const host = url.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  return value
    .split(/[\s,]+/)
    .filter(Boolean)
    .some((entry) => {
      if (entry === '*') return true;
      const match = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(entry.toLowerCase());
      const pattern = match ? match[1]! : entry.toLowerCase();
      if (match?.[2] && match[2] !== port) return false;
      let suffix = pattern
        .replace(/^\[|\]$/g, '')
        .replace(/^\*?\./, '')
        .replace(/\.$/, '');
      if (isIP(suffix) === 6) suffix = new URL(`http://[${suffix}]`).hostname.slice(1, -1);
      if (isIP(suffix)) return host === suffix;
      return host === suffix || (!suffix.includes(':') && host.endsWith(`.${suffix}`));
    });
}
