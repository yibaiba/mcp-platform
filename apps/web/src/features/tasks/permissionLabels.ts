import { useQuery } from '@tanstack/react-query';
import {
  api,
  type Tool,
  type ContentEntry,
  type Artifact,
  type Connection,
} from '../../lib/api.js';

export function usePermissionLabels() {
  const metadata = useQuery({
    queryKey: ['permission-labels'],
    queryFn: async () => {
      const [tools, content, artifacts, connections] = await Promise.all([
        api<Tool[]>('/tools'),
        api<ContentEntry[]>('/catalog'),
        api<Artifact[]>('/artifacts'),
        api<Connection[]>('/connections'),
      ]);
      const connectionName = (id: string) => {
        const connection = connections.find((row) => row.id === id);
        return connection ? `${connection.name} · ${connection.deviceId ?? '平台主机'}` : id;
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
