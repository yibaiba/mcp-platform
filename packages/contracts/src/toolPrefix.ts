import { z } from 'zod';

/**
 * The connection part of a readable tool name (`prefix__tool`). Shared by the server, which builds
 * the names, and the web forms, which preview and suggest them, so both always agree.
 */
export const TOOL_PREFIX_MAX = 20;
const ID_SUFFIX = 6;
/** User-set English identifier: lowercase ASCII words joined by single `_`/`-`, ≤20 chars. */
export const toolPrefix = z
  .string()
  .trim()
  .max(TOOL_PREFIX_MAX, `英文标识最多 ${TOOL_PREFIX_MAX} 个字符`)
  .regex(/^[a-z0-9]+(?:[_-][a-z0-9]+)*$/, '英文标识只能用小写字母、数字，以及单个 _ 或 - 分隔');

/** ASCII-folds and keeps `[A-Za-z0-9_-]`; other runs become `_`. */
export function toolNameSlug(value: string) {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^[_-]+|[_-]+$/g, '');
}
const trimEnd = (value: string) => value.replace(/[_-]+$/, '');

/**
 * The prefix a connection's tools get: the user-set identifier when present; otherwise the name
 * (ASCII-folded, lowercase, ≤20) and, when nothing ASCII is left (e.g. a Chinese name), `c` plus
 * the first 6 hex digits of the connection id. Without a user-set identifier this never changes on
 * upgrade, so existing client tool names stay stable.
 */
export function connectionToolPrefix(
  connectionId: string,
  name: string | undefined,
  prefix?: string | null,
) {
  if (prefix) return prefix;
  const value = trimEnd(
    toolNameSlug(name ?? '')
      .toLowerCase()
      .slice(0, TOOL_PREFIX_MAX),
  );
  return value || `c${connectionId.replace(/-/g, '').slice(0, ID_SUFFIX)}`;
}

/** Whether the name keeps no meaning in a tool prefix (it is all non-ASCII, e.g. Chinese). */
export function nameNeedsToolPrefix(name: string) {
  return Boolean(name.trim()) && !toolNameSlug(name);
}

const clean = (value: string) =>
  trimEnd(
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+/, '')
      .slice(0, TOOL_PREFIX_MAX),
  );
const generic = new Set(['mcp', 'sse', 'api', 'v1', 'v2', 'www', 'server', 'index', 'main', 'src']);
const runners = new Set(['npx', 'uvx', 'node', 'python', 'python3', 'bun', 'bunx', 'deno', 'pnpm']);
function meaningful(parts: string[]) {
  for (const part of parts) {
    const value = clean(
      part
        .replace(/\.(m?js|cjs|ts|py|exe)$/i, '')
        .replace(/^(mcp|server)[-_]|[-_](mcp|server)$/g, ''),
    );
    if (value.length >= 2 && !generic.has(value) && !/^\d+$/.test(value)) return value;
  }
  return '';
}

/**
 * A suggested English identifier: from the name when it is ASCII, else from the URL (host or last
 * path segment) or the command / package. Empty when nothing meaningful is found.
 */
export function suggestToolPrefix(input: {
  name?: string;
  url?: string;
  command?: string;
  args?: readonly string[];
}) {
  const fromName = clean(toolNameSlug(input.name ?? ''));
  if (fromName.length >= 2) return fromName;
  if (input.url)
    try {
      const url = new URL(input.url);
      const host = url.hostname;
      const local = host === 'localhost' || /^[\d.]+$/.test(host) || host.includes(':');
      const segments = url.pathname.split('/').filter(Boolean).reverse();
      const hostParts = local ? [] : host.split('.').slice(0, -1);
      const found = meaningful([...hostParts, ...segments]);
      if (found) return found;
    } catch {
      // Not a URL yet (the user is still typing); try the command instead.
    }
  const args = (input.args ?? []).filter((arg) => !arg.startsWith('-'));
  const base = (arg: string) => arg.split(/[\\/]/).filter(Boolean).pop() ?? '';
  // A package (`@scope/name`, `name`) says more than a data path such as `/tmp`.
  const isPath = (arg: string) => /^([./~]|[A-Za-z]:\\)/.test(arg);
  const tokens = [
    ...args.filter((arg) => !isPath(arg)),
    ...args.filter(isPath).filter((arg) => /\.(m?js|cjs|ts|py|exe)$/i.test(arg)),
  ].map(base);
  const command = input.command?.split(/[\\/]/).pop() ?? '';
  return meaningful([...tokens, ...(runners.has(command) ? [] : [command])]);
}
