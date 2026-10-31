export async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`/api/v1${path}`, {
    credentials: 'include',
    ...options,
    headers: {
      ...(options?.body && typeof options.body === 'string'
        ? { 'Content-Type': 'application/json' }
        : {}),
      ...options?.headers,
    },
  });
  const value = await response.json();
  if (!response.ok)
    throw new ApiError(
      value.error?.message ?? value.error ?? value.message ?? `请求失败 (${response.status})`,
      response.status,
      typeof value.code === 'string' ? value.code : undefined,
    );
  return value as T;
}
/** Carries the HTTP status so screens can tell permission failures from other errors. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}
export const isForbidden = (error: unknown) =>
  error instanceof ApiError && (error.status === 403 || error.code === 'ADMIN_REQUIRED');
export const json = (value: unknown) => JSON.stringify(value);
export type Device = {
  id: string;
  name: string;
  online: boolean;
  revoked: boolean;
  pairingRequired: boolean;
  credentialVersion: number;
  os: string | null;
  hostname: string | null;
  version: string | null;
  lastSeen: string | null;
  services: { id: string; status: string; error?: string }[];
};
export type Connection = {
  presetId?: string;
  revision: number;
  identityMode?: string;
  sessions?: string[];
  lifecycle?: { startup: string; idleTimeoutMs?: number; shutdownGraceMs: number };
  health?: {
    enabled: boolean;
    intervalMs: number;
    timeoutMs: number;
    recover: boolean;
    initialIntervalMs?: number;
    maxIntervalMs?: number;
  };
  connectTimeoutMs?: number;
  requestOptions?: {
    timeoutMs: number;
    resetTimeoutOnProgress: boolean;
    maxTotalTimeoutMs?: number;
  };
  recovery?: {
    sessionId?: string;
    status: string;
    attempts: number;
    nextAt?: string;
    error?: string;
  }[];
  forwardHeaders?: string[];
  source?: string;
  id: string;
  name: string;
  adapter: string;
  transport: string;
  mode: string;
  deviceId: string | null;
  /** The connection's device is offline, so its tools cannot run until the connector is back. */
  deviceOffline?: boolean;
  status: string;
  error: string | null;
  url?: string;
  protocolVersion?: string | null;
  capabilities?: Record<string, unknown>;
};
export type Tool = {
  id: string;
  name: string;
  connectionId: string;
  /** Present when the tool's connection or device is down; Agents do not see it in tools/list. */
  unavailable?: { code: string; message: string };
  definition: {
    description?: string;
    inputSchema: unknown;
    outputSchema?: unknown;
    [key: string]: unknown;
  };
};
export type ContentEntry = {
  id: string;
  connectionId: string;
  kind: 'prompt' | 'resource' | 'template';
  name: string;
  locator: string;
  definition: {
    description?: string;
    arguments?: { name: string; description?: string; required?: boolean }[];
    [key: string]: unknown;
  };
};
export type Profile = {
  discoveryMode: 'direct' | 'search';
  searchOptions: import('@platform/contracts').SearchOptions;
  resultPresentation: import('@platform/contracts').ResultPresentation;
  pinnedTools: string[];
  embedding: import('@platform/contracts').EmbeddingConfig | null;
  deploymentState: string;
  catalog: import('@platform/contracts').CatalogOptions;
  revision: number;
  requestable: { toolIds: string[]; contentIds: string[]; artifactIds: string[] };
  connectionIdentities: Record<string, string>;
  instructions?: string;
  id: string;
  name: string;
  toolIds: string[];
  contentIds: string[];
  skillVersionIds: string[];
  artifactIds: string[];
};
export type Skill = {
  id: string;
  name: string;
  digest: string;
  source: string;
  revision: string | null;
  createdAt: string;
  dependencies: string[];
};
export type Artifact = {
  id: string;
  name: string;
  sha256: string;
  size: number;
  createdAt: string;
};
export type Call = {
  profileId?: string;
  taskId?: string;
  bindingId?: string;
  credentialId?: string;
  entry?: string;
  phase?: string;
  correlationId?: string;
  revision: number;
  id: string;
  toolId: string;
  adapter: string;
  connectionId: string;
  deviceId: string | null;
  status: string;
  error: string | null;
  startedAt: string;
  endedAt: string | null;
};

export const profileUpdate = (profile: Profile, patch: Partial<Profile>) => ({
  name: profile.name,
  instructions: profile.instructions,
  toolIds: profile.toolIds,
  contentIds: profile.contentIds,
  skillVersionIds: profile.skillVersionIds,
  artifactIds: profile.artifactIds,
  revision: profile.revision,
  requestable: profile.requestable,
  connectionIdentities: profile.connectionIdentities,
  ...patch,
});
