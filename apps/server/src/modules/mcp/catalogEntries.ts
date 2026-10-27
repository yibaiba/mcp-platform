import type { McpCatalog } from '@platform/mcp';
import { digest } from '../../shared/crypto.js';
import type { ConnectionContext } from './adapter.js';

export const scopedUri = (connectionId: string, uri: string) =>
  uri.startsWith('ui://')
    ? `ui://${connectionId}/${uri.slice('ui://'.length)}`
    : `mcp-platform://${connectionId}/${uri}`;
export function originalUri(connectionId: string, uri: string) {
  const ui = `ui://${connectionId}/`;
  if (uri.startsWith(ui)) return `ui://${uri.slice(ui.length)}`;
  const prefix = scopedUri(connectionId, '');
  return uri.startsWith(prefix) ? uri.slice(prefix.length) : undefined;
}
export function scopeToolDefinition(connectionId: string, definition: Record<string, unknown>) {
  const meta = definition._meta as { ui?: { resourceUri?: string } } | undefined;
  if (!meta?.ui?.resourceUri) return definition;
  return {
    ...definition,
    _meta: {
      ...meta,
      ui: { ...meta.ui, resourceUri: scopedUri(connectionId, meta.ui.resourceUri) },
    },
  };
}
export function catalogEntries(context: ConnectionContext, catalog: McpCatalog) {
  const groups = [
    {
      kind: 'prompt' as const,
      items: catalog.prompts.map((definition) => ({ definition, locator: definition.name })),
    },
    {
      kind: 'resource' as const,
      items: catalog.resources.map((definition) => ({ definition, locator: definition.uri })),
    },
    {
      kind: 'template' as const,
      items: catalog.templates.map((definition) => ({
        definition,
        locator: definition.uriTemplate,
      })),
    },
  ];
  return groups.flatMap(({ kind, items }) =>
    items.map(({ definition, locator }) => ({
      id: `${kind}_${digest(`${context.id}:${locator}`)}`,
      ownerId: context.ownerId,
      connectionId: context.id,
      kind,
      name: definition.name,
      locator,
      definition,
      available: true,
    })),
  );
}

function scopeBlock(connectionId: string, block: Record<string, unknown>) {
  if (block.type === 'resource_link' && typeof block.uri === 'string')
    return { ...block, uri: scopedUri(connectionId, block.uri) };
  if (block.type === 'resource' && block.resource && typeof block.resource === 'object') {
    const resource = block.resource as Record<string, unknown>;
    if (typeof resource.uri === 'string')
      return { ...block, resource: { ...resource, uri: scopedUri(connectionId, resource.uri) } };
  }
  return block;
}

export function scopeResult<T extends Record<string, unknown>>(connectionId: string, result: T): T {
  const content = Array.isArray(result.content)
    ? result.content.map((block) => scopeBlock(connectionId, block))
    : result.content;
  const contents = Array.isArray(result.contents)
    ? result.contents.map((item) => ({ ...item, uri: scopedUri(connectionId, item.uri) }))
    : result.contents;
  const messages = Array.isArray(result.messages)
    ? result.messages.map((message) => ({
        ...message,
        content: scopeBlock(connectionId, message.content),
      }))
    : result.messages;
  return {
    ...result,
    ...(content ? { content } : {}),
    ...(contents ? { contents } : {}),
    ...(messages ? { messages } : {}),
  };
}
