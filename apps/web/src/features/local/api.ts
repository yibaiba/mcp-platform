import type { LocalBinding, LocalRequest, LocalResource, LocalState } from '@platform/contracts';
export type Inventory = LocalState & {
  bindings?: (LocalBinding & { localContent?: LocalBinding['content'] })[];
  platformOperations?: {
    id: string;
    action: string;
    phase: string;
    error: string | null;
    createdAt: string;
  }[];
};
export type ManagementApi = {
  remote: boolean;
  load: () => Promise<Inventory>;
  request: (input: LocalRequest) => Promise<unknown>;
  versions?: (resource: LocalResource) => Promise<{ id: string; label: string }[]>;
  version?: (id: string) => Promise<Record<string, string>>;
  sync?: () => Promise<unknown>;
  binding?: (
    binding: LocalBinding,
    input: { action: string; content?: unknown; choice?: string; confirm?: boolean },
  ) => Promise<unknown>;
};
export function localApi(csrf: string): ManagementApi {
  const request = async (input: LocalRequest) => {
    const response = await fetch('/local-api/v1/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
      body: JSON.stringify(input),
    });
    const result = await response.json();
    if (!response.ok || ['failed', 'conflict', 'interrupted'].includes(result.phase))
      throw new Error(result.error ?? `请求失败 (${response.status})`);
    return result;
  };
  return {
    remote: false,
    request,
    load: () => request({ action: 'state' }),
    versions: async (resource) => {
      const state: LocalState = await request({ action: 'state' });
      return Object.values(state.operations)
        .filter((op) => op.resourceId === resource.id && op.backup && op.action !== 'delete')
        .map((op) => ({
          id: op.id,
          label: `${new Date(op.createdAt).toLocaleString()} · 修改前副本`,
        }));
    },
    version: (id) => request({ action: 'backup', id }),
  };
}

export function operationResult<T>(value: T): T {
  if (
    value &&
    typeof value === 'object' &&
    'phase' in value &&
    ['failed', 'conflict', 'interrupted'].includes(String(value.phase))
  ) {
    throw new Error('error' in value ? String(value.error) : `操作未完成：${String(value.phase)}`);
  }
  return value;
}
