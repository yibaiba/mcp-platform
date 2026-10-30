import { z } from 'zod';
import type { Connection, Device, Profile, Tool } from '../../lib/api.js';
export const toolSearch = z.object({
  profileId: z.string().optional(),
  connectionId: z.string().optional(),
  deviceId: z.string().optional(),
  toolId: z.string().optional(),
  q: z.string().optional(),
});
export type ToolSearch = z.infer<typeof toolSearch>;
export function executionLocation(connection: Connection, devices: ReadonlyMap<string, Device>) {
  if (connection.adapter !== 'device') return '平台服务器';
  if (!connection.deviceId) return '尚未选择设备';
  return devices.get(connection.deviceId)?.name ?? connection.deviceId;
}
export function identityLabel(connection: Connection, profile?: Profile) {
  const mode = profile?.connectionIdentities[connection.id] ?? 'inherit';
  if (mode === 'profile') return 'Agent 专属身份';
  if (mode === 'credential') return '按调用凭证隔离';
  return connection.identityMode === 'independent' ? '沿用连接：按调用凭证隔离' : '沿用连接账号';
}
export function filterTools(input: {
  tools: Tool[];
  connections: Connection[];
  devices: Device[];
  filters: ToolSearch;
}) {
  const connections = new Map(input.connections.map((item) => [item.id, item]));
  const devices = new Map(input.devices.map((item) => [item.id, item]));
  const query = input.filters.q?.trim().toLocaleLowerCase() ?? '';
  return input.tools.filter((tool) => {
    const connection = connections.get(tool.connectionId);
    if (input.filters.connectionId && tool.connectionId !== input.filters.connectionId)
      return false;
    if (input.filters.deviceId === 'platform' && (!connection || connection.adapter === 'device'))
      return false;
    if (
      input.filters.deviceId &&
      input.filters.deviceId !== 'platform' &&
      (connection?.adapter !== 'device' || connection.deviceId !== input.filters.deviceId)
    )
      return false;
    const location = connection ? executionLocation(connection, devices) : '';
    return `${tool.name} ${tool.definition.description ?? ''} ${connection?.name ?? ''} ${location}`
      .toLocaleLowerCase()
      .includes(query);
  });
}
