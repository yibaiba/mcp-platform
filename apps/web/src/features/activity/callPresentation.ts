import type { Call, Connection, Device, Profile, Tool } from '../../lib/api.js';
export function callNames(options: {
  tools?: Tool[];
  connections?: Connection[];
  profiles?: Profile[];
  devices?: Device[];
}) {
  return {
    tools: new Map(options.tools?.map((item) => [item.id, item.name])),
    connections: new Map(options.connections?.map((item) => [item.id, item.name])),
    profiles: new Map(options.profiles?.map((item) => [item.id, item.name])),
    devices: new Map(options.devices?.map((item) => [item.id, item.name])),
  };
}
export type CallNames = ReturnType<typeof callNames>;
export function callDuration(call: Call) {
  return call.endedAt
    ? `${new Date(call.endedAt).getTime() - new Date(call.startedAt).getTime()} ms`
    : '尚未结束';
}
export function callLocation(call: Call, names: CallNames) {
  return call.deviceId ? (names.devices.get(call.deviceId) ?? call.deviceId) : '平台主机';
}
export const callPhase = (phase?: string | null) =>
  ({
    dispatch: '准备派发',
    upstream: '上游执行',
    interaction: '等待交互',
    authorization: '权限检查',
  })[phase ?? ''] ??
  phase ??
  '未记录';
export const callEntry = (entry?: string | null) =>
  ({ dashboard: '管理界面', mcp: '外部 MCP', pi: '内置 Pi' })[entry ?? ''] ?? entry ?? '未记录';
