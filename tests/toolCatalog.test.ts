import { expect, test } from 'vitest';
import { filterTools } from '../apps/web/src/features/tools/toolCatalog.js';
import type { Connection, Device, Tool } from '../apps/web/src/lib/api.js';

const connections: Connection[] = [
  {
    id: 'local',
    name: '平台资料',
    revision: 1,
    adapter: 'direct',
    transport: 'http',
    mode: 'existing',
    deviceId: null,
    status: 'connected',
    error: null,
  },
  {
    id: 'remote',
    name: '设计资料',
    revision: 1,
    adapter: 'device',
    transport: 'stdio',
    mode: 'managed',
    deviceId: 'mac',
    status: 'connected',
    error: null,
  },
];
const devices: Device[] = [
  {
    id: 'mac',
    name: '设计工作站',
    online: false,
    revoked: false,
    os: 'darwin',
    hostname: 'studio',
    version: '1',
    lastSeen: null,
    services: [],
  },
];
const tools: Tool[] = ['local', 'remote', 'removed'].map((connectionId) => ({
  id: `${connectionId}:search`,
  name: 'search',
  connectionId,
  definition: { inputSchema: {} },
}));
const catalog = { tools, connections, devices };

test('same-name tools remain distinct when filtering by connection or device', () => {
  expect(
    filterTools({ ...catalog, filters: { connectionId: 'remote' } }).map((tool) => tool.id),
  ).toEqual(['remote:search']);
  expect(filterTools({ ...catalog, filters: { deviceId: 'mac' } }).map((tool) => tool.id)).toEqual([
    'remote:search',
  ]);
  expect(
    filterTools({ ...catalog, filters: { deviceId: 'platform' } }).map((tool) => tool.id),
  ).toEqual(['local:search']);
  expect(filterTools({ ...catalog, filters: { deviceId: 'mac', connectionId: 'local' } })).toEqual(
    [],
  );
});

test('search resolves connection and device names without hiding offline devices', () => {
  expect(
    filterTools({ ...catalog, filters: { q: '  设计工作站  ' } }).map((tool) => tool.id),
  ).toEqual(['remote:search']);
  expect(filterTools({ ...catalog, filters: { q: '平台资料' } }).map((tool) => tool.id)).toEqual([
    'local:search',
  ]);
  expect(filterTools({ ...catalog, filters: { q: 'SEARCH' } })).toHaveLength(3);
});
