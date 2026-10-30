import { useQuery } from '@tanstack/react-query';
import { api, type Connection, type Device } from '../../lib/api.js';
import { executionLocation } from '../tools/toolCatalog.js';

/**
 * Readable "name · where it runs" for every connection whose tools the user can see: their own
 * and the ones shared with them, so no screen falls back to showing a connection UUID.
 */
export function useConnectionNames() {
  const connections = useQuery({
    queryKey: ['connections'],
    queryFn: () => api<Connection[]>('/connections'),
  });
  const devices = useQuery({ queryKey: ['devices'], queryFn: () => api<Device[]>('/devices') });
  const shares = useQuery({
    queryKey: ['incoming-shares'],
    queryFn: () => api<{ connectionId: string; name: string }[]>('/shares'),
  });
  const deviceById = new Map(devices.data?.map((device) => [device.id, device]));
  const names = new Map<string, { name: string; location: string; shared: boolean }>();
  for (const share of shares.data ?? [])
    names.set(share.connectionId, { name: share.name, location: '共享给我', shared: true });
  for (const connection of connections.data ?? [])
    names.set(connection.id, {
      name: connection.name,
      location: executionLocation(connection, deviceById),
      shared: false,
    });
  return {
    names,
    label: (id: string) => {
      const entry = names.get(id);
      return entry ? `${entry.name} · ${entry.location}` : '未知连接';
    },
    error: connections.error ?? devices.error ?? shares.error,
  };
}
