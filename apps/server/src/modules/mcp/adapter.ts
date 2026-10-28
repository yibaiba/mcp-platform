import type { McpToolResult, McpRequestOptions } from '@platform/mcp';
import type { Tool } from '@platform/mcp';
import type { ConnectionInput } from '@platform/contracts';
import type { McpCatalog, McpOperation, McpNotification, Progress } from '@platform/mcp';
export type ConnectionContext = {
  profileId?: string;
  revision?: number;
  id: string;
  ownerId: string;
  resourceOwnerId?: string;
  shareId?: string;
  shareVersion?: number;
  credentialScope?: { ownerId: string; connectionId: string; bindingId: string; identity: string };
  config: ConnectionInput;
  bindingId?: string;
  identity?: string;
  runtimeKey?: string;
  capabilityKey?: string;
  sessionId?: string;
  capabilities?: Record<string, unknown>;
  correlationId?: string;
};
export interface ConnectionAdapter {
  status(): 'connected' | 'disconnected';
  discover(signal?: AbortSignal): Promise<Tool[]>;
  catalog(signal?: AbortSignal): Promise<McpCatalog>;
  request(operation: McpOperation, options?: McpRequestOptions): Promise<unknown>;
  watch(listener: (event: McpNotification) => void): () => void;
  call(input: {
    name: string;
    arguments: Record<string, unknown>;
    signal?: AbortSignal;
    executionTimeoutMs?: number;
    onprogress?: (progress: Progress) => void;
    requestState?: string;
    inputResponses?: Record<string, unknown>;
  }): Promise<McpToolResult>;
  check?(signal?: AbortSignal): Promise<void>;
  close(): Promise<void>;
}
export type AdapterFactory = (connection: ConnectionContext) => Promise<ConnectionAdapter>;
