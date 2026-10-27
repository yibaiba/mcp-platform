export {
  Client,
  auth,
  StreamableHTTPClientTransport,
  SSEClientTransport,
  isInputRequiredResult,
} from '@modelcontextprotocol/client';
export { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
export type {
  OAuthClientProvider,
  Tool,
  Prompt,
  Resource,
  ResourceTemplateType,
  CallToolResult,
  InputRequiredResult,
  GetPromptResult,
  ReadResourceResult,
  Progress,
} from '@modelcontextprotocol/client';
export * from './catalog.js';
export * from './operations.js';
export * from './notifications.js';
export * from './parseCatalog.js';
export * from './schemaCompatibility.js';

export { ManagedStdioTransport } from './lifecycle/managedStdio.js';
export { InteractiveClient } from './interactiveClient.js';
export { toolDispatchFetch } from './toolDispatchFetch.js';
