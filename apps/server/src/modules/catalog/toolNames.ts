import { connectionToolPrefix, toolNameSlug } from '@platform/contracts';
import { digest } from '../../shared/crypto.js';

/** External MCP tool names: `[A-Za-z0-9_-]`, at most 48 characters, readable and deterministic. */
export const TOOL_NAME_MAX = 48;
/** Names exposed before readable naming; still accepted by tools/call, never listed. */
export const legacyToolName = /^t_[0-9a-f]{64}$/;
const SUFFIX = 6;

const slug = toolNameSlug;
function trimEnd(value: string) {
  return value.replace(/[_-]+$/, '');
}
/** A connection's display name, optionally with the user-set English prefix (see `toolPrefix`). */
export type ConnectionLabel = string | { name: string; prefix?: string | null };
function connectionSlug(connectionId: string, label: ConnectionLabel | undefined) {
  return typeof label === 'object'
    ? connectionToolPrefix(connectionId, label.name, label.prefix)
    : connectionToolPrefix(connectionId, label);
}
function toolSlug(name: string) {
  return slug(name) || `t${digest(name).slice(0, SUFFIX)}`;
}
/** Truncates `base` and appends a hash of the stable tool id so the result stays ≤48. */
function suffixed(base: string, id: string, length: number) {
  const hash = digest(id).slice(0, length);
  return `${trimEnd(base.slice(0, TOOL_NAME_MAX - 1 - hash.length))}_${hash}`;
}

/**
 * `connslug__toolname`. The connection slug is the user-set English prefix when present, else the
 * connection name (ASCII-folded, lowercase, ≤20), falling back to the connection id prefix; too-long names are truncated with a
 * hash suffix. Collisions resolve in ascending stable tool id order: the first keeps the plain
 * name, later ones get a hash suffix of their tool id. Same input set → same names.
 */
export function readableToolNames(
  tools: readonly { id: string; connectionId: string; name: string }[],
  connectionNames: ReadonlyMap<string, ConnectionLabel> | undefined,
  taken: ReadonlySet<string>,
) {
  const used = new Set(taken);
  const names = new Map<string, string>();
  for (const tool of [...tools].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    if (names.has(tool.id)) continue;
    const full = `${connectionSlug(tool.connectionId, connectionNames?.get(tool.connectionId))}__${toolSlug(tool.name)}`;
    const base = full.length > TOOL_NAME_MAX ? suffixed(full, tool.id, SUFFIX) : full;
    let candidate = base;
    for (let length = SUFFIX; used.has(candidate); length += 2)
      candidate = suffixed(base, tool.id, Math.min(length, 64));
    used.add(candidate);
    names.set(tool.id, candidate);
  }
  return names;
}
