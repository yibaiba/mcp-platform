import { useQuery } from '@tanstack/react-query';
import {
  api,
  type Tool,
  type ContentEntry,
  type Artifact,
  type Connection,
  type Device,
} from '../../lib/api.js';
import { executionLocation } from '../tools/toolCatalog.js';

export function usePermissionLabels() {
  const metadata = useQuery({
    queryKey: ['permission-labels'],
    queryFn: async () => {
      const [tools, content, artifacts, connections, devices] = await Promise.all([
        api<Tool[]>('/tools'),
        api<ContentEntry[]>('/catalog'),
        api<Artifact[]>('/artifacts'),
        api<Connection[]>('/connections'),
        api<Device[]>('/devices'),
      ]);
      const deviceById = new Map(devices.map((device) => [device.id, device]));
      const connectionName = (id: string) => {
        const connection = connections.find((row) => row.id === id);
        return connection
          ? `${connection.name} · ${executionLocation(connection, deviceById)}`
          : id;
      };
      return new Map([
        ...[...tools, ...content].map(
          (row) => [row.id, `${row.name} · ${connectionName(row.connectionId)}`] as const,
        ),
        ...artifacts.map((row) => [row.id, row.name] as const),
      ]);
    },
  });
  return { error: metadata.error, label: (id: string) => metadata.data?.get(id) ?? id };
}
