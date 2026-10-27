import type { Client } from '@modelcontextprotocol/client';
export type McpNotification = {
  method:
    | 'notifications/tools/list_changed'
    | 'notifications/prompts/list_changed'
    | 'notifications/resources/list_changed'
    | 'notifications/resources/updated';
  params?: Record<string, unknown>;
};
const methods = new Set<string>([
  'notifications/tools/list_changed',
  'notifications/prompts/list_changed',
  'notifications/resources/list_changed',
  'notifications/resources/updated',
]);

export function observeNotifications(client: Client, notify: (event: McpNotification) => void) {
  const transport = client.transport;
  if (!transport) throw new Error('MCP transport is not connected');
  const previous = transport.onmessage;
  const observer: typeof transport.onmessage = (message, extra) => {
    previous?.(message, extra);
    if ('method' in message && !('id' in message) && methods.has(message.method)) {
      notify({ method: message.method as McpNotification['method'], params: message.params });
    }
  };
  transport.onmessage = observer;
  return () => {
    if (transport.onmessage === observer) transport.onmessage = previous;
  };
}
