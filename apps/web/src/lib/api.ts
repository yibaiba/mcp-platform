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
    throw new Error(
      value.error?.message ?? value.error ?? value.message ?? `请求失败 (${response.status})`,
    );
  return value as T;
}
export const json = (value: unknown) => JSON.stringify(value);
export type Device = {
  id: string;
  name: string;
  online: boolean;
  revoked: boolean;
  os: string | null;
  hostname: string | null;
  version: string | null;
  lastSeen: string | null;
  services: { id: string; status: string; error?: string }[];
};
export type Connection = {
  revision: number;
  identityMode?: string;
  sessions?: string[];
  lifecycle?: { startup: string; idleTimeoutMs?: number; shutdownGraceMs: number };
  health?: { enabled: boolean; intervalMs: number; timeoutMs: number; recover: boolean };
  forwardHeaders?: string[];
  source?: string;
  id: string;
  name: string;
  adapter: string;
  transport: string;
  mode: string;
  deviceId: string | null;
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
