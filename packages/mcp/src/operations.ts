import {
  isInputRequiredResult,
  type Client,
  type Progress,
  type Tool,
  type InputRequiredResult,
  type CallToolResult,
} from '@modelcontextprotocol/client';
import { validateToolValue } from './catalog.js';
type ResourceSubscription = Awaited<ReturnType<Client['listen']>>;
const subscriptions = new WeakMap<Client, Map<string, ResourceSubscription>>();

export type McpOperation =
  | { method: 'prompts/get'; params: { name: string; arguments?: Record<string, string> } }
  | {
      method: 'resources/read' | 'resources/subscribe' | 'resources/unsubscribe';
      params: { uri: string };
    };
export type McpRequestOptions = {
  executionTimeoutMs?: number;
  signal?: AbortSignal;
  onprogress?: (progress: Progress) => void;
  requestState?: string;
  inputResponses?: Record<string, unknown>;
};
export type McpToolResult = CallToolResult | InputRequiredResult;

export async function executeOperation(
  client: Client,
  operation: McpOperation,
  options: McpRequestOptions = {},
) {
  const requestOptions = {
    ...options,
    ...(options.executionTimeoutMs === undefined ? {} : { timeout: 0 }),
  };
  switch (operation.method) {
    case 'prompts/get':
      return client.getPrompt(operation.params, requestOptions);
    case 'resources/read':
      return client.readResource(operation.params, { ...requestOptions, cacheMode: 'refresh' });
    case 'resources/subscribe': {
      if (client.getProtocolEra() !== 'modern')
        return client.subscribeResource(operation.params, requestOptions);
      const active = subscriptions.get(client) ?? new Map<string, ResourceSubscription>();
      subscriptions.set(client, active);
      if (!active.has(operation.params.uri))
        active.set(
          operation.params.uri,
          await client.listen(
            { resourceSubscriptions: [operation.params.uri] },
            {
              ...options,
              ...(options.executionTimeoutMs === undefined
                ? {}
                : { timeout: options.executionTimeoutMs }),
            },
          ),
        );
      return {};
    }
    case 'resources/unsubscribe': {
      if (client.getProtocolEra() !== 'modern')
        return client.unsubscribeResource(operation.params, requestOptions);
      const active = subscriptions.get(client);
      await active?.get(operation.params.uri)?.close();
      active?.delete(operation.params.uri);
      return {};
    }
  }
}

export async function executeTool(
  client: Client,
  input: { tool: Tool; arguments: Record<string, unknown> } & McpRequestOptions,
) {
  validateToolValue({ tool: input.tool, value: input.arguments, field: 'inputSchema' });
  // Raw spec request avoids callTool's HEADER_MISMATCH recovery replay.
  const result = (await client.request(
    {
      method: 'tools/call',
      params: {
        name: input.tool.name,
        arguments: input.arguments,
        ...(input.requestState ? { requestState: input.requestState } : {}),
        ...(input.inputResponses ? { inputResponses: input.inputResponses } : {}),
      },
    },
    { signal: input.signal, onprogress: input.onprogress, allowInputRequired: true, timeout: 0 },
  )) as McpToolResult;
  if (isInputRequiredResult(result)) return result;
  if (!result.isError && input.tool.outputSchema) {
    validateToolValue({ tool: input.tool, value: result.structuredContent, field: 'outputSchema' });
  }
  return result;
}
