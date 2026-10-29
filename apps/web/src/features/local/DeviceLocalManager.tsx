import { useMemo } from 'react';
import { api, json } from '../../lib/api.js';
import { LocalManager } from './LocalManager.js';
import { operationResult, type ManagementApi } from './api.js';
export default function DeviceLocalManager({ deviceId }: { deviceId: string }) {
  const management = useMemo<ManagementApi>(
    () => ({
      remote: true,
      load: () => api(`/devices/${deviceId}/local`),
      request: async (input) =>
        operationResult(
          await api(`/devices/${deviceId}/local/request`, { method: 'POST', body: json(input) }),
        ),
      versions: async (resource) => {
        const versions =
          await api<{ id: string; name: string; source: string; createdAt: string }[]>('/skills');
        return versions
          .filter(
            (version) =>
              version.name === resource.name &&
              version.source === `device:${deviceId}:${resource.id}`,
          )
          .map((version) => ({
            id: version.id,
            label: new Date(version.createdAt).toLocaleString(),
          }));
      },
      version: async (id) => (await api<{ files: Record<string, string> }>(`/skills/${id}`)).files,
      sync: () =>
        api(`/devices/${deviceId}/local/sync`, {
          method: 'POST',
          body: json({ operationId: crypto.randomUUID() }),
        }),
      binding: (binding, input) =>
        api(`/devices/${deviceId}/local/bindings/${binding.id}`, {
          method: 'POST',
          body: json({ ...input, revision: binding.revision, operationId: crypto.randomUUID() }),
        }),
    }),
    [deviceId],
  );
  return <LocalManager api={management} />;
}
