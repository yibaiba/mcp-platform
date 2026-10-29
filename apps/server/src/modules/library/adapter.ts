import { z } from 'zod';
import { libraryItem, renderPrompt } from '@platform/contracts';
import type { McpCatalog } from '@platform/mcp';
import type { ConnectionAdapter, ConnectionContext } from '../mcp/adapter.js';
import { AppError } from '../../shared/errors.js';
export function createLibraryAdapter(context: ConnectionContext): ConnectionAdapter {
  const item = libraryItem.parse(context.config.library);
  let closed = false;
  const check = () => {
    if (closed) throw new AppError('CONNECTION_CLOSED', '内容会话已经关闭', 409);
    if (!item.enabled) throw new AppError('CONTENT_DISABLED', '内容已停用', 409);
  };
  const definition = { name: item.name, title: item.title, description: item.description };
  const catalog: McpCatalog = {
    tools: [],
    templates: [],
    prompts:
      item.enabled && item.kind === 'prompt' ? [{ ...definition, arguments: item.arguments }] : [],
    resources:
      item.enabled && item.kind === 'resource'
        ? [{ ...definition, uri: item.uri, mimeType: item.mimeType }]
        : [],
    capabilities: { prompts: { listChanged: true }, resources: { listChanged: true } },
    serverInfo: { name: 'platform-library', version: '1' },
  };
  return {
    status: () => (closed ? 'disconnected' : 'connected'),
    discover: async () => {
      if (closed) check();
      return [];
    },
    catalog: async () => {
      if (closed) check();
      return catalog;
    },
    watch: () => () => {},
    close: async () => {
      closed = true;
    },
    call: async () => {
      throw new AppError('METHOD_UNSUPPORTED', '内容库不提供业务工具');
    },
    request: async (operation, options) => {
      options?.signal?.throwIfAborted();
      check();
      if (item.kind === 'prompt' && operation.method === 'prompts/get') {
        const params = z
          .object({
            name: z.literal(item.name),
            arguments: z.record(z.string(), z.string()).default({}),
          })
          .parse(operation.params);
        try {
          return {
            description: item.description,
            messages: [
              {
                role: 'user',
                content: { type: 'text', text: renderPrompt(item, params.arguments) },
              },
            ],
          };
        } catch (cause) {
          throw new AppError('PROMPT_ARGUMENTS', (cause as Error).message);
        }
      }
      if (item.kind === 'resource' && operation.method === 'resources/read') {
        z.object({ uri: z.literal(item.uri) }).parse(operation.params);
        return { contents: [{ uri: item.uri, mimeType: item.mimeType, text: item.content }] };
      }
      throw new AppError('METHOD_UNSUPPORTED', '内容库不支持此操作');
    },
  };
}
