import { useQuery } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { Card } from '../../components/ui/card.js';
import { Table, TableBody, TableHead, TableHeader, TableRow } from '../../components/ui/table.js';
import {
  api,
  type Call,
  type Tool,
  type Connection,
  type Profile,
  type Device,
} from '../../lib/api.js';
import { Empty, Feedback } from '../../components/shared/Controls.js';
import { ActivityFilters } from './ActivityFilters.js';
import type { ActivitySearch } from './activitySearch.js';
import { callNames } from './callPresentation.js';
import { CallRow } from './CallRow.js';
import { CallDetail } from './CallDetail.js';
export default function ActivityPage() {
  const filters = useSearch({ from: '/activity' });
  const navigate = useNavigate({ from: '/activity' });
  const search = new URLSearchParams(
    Object.entries(filters).filter(([key, value]) => key !== 'callId' && Boolean(value)) as [
      string,
      string,
    ][],
  ).toString();
  const calls = useQuery({
    queryKey: ['calls', search],
    queryFn: ({ signal }) => api<Call[]>(`/calls?${search}`, { signal }),
    refetchInterval: 5000,
  });
  const tools = useQuery({ queryKey: ['tools'], queryFn: () => api<Tool[]>('/tools') });
  const connections = useQuery({
    queryKey: ['connections'],
    queryFn: () => api<Connection[]>('/connections'),
  });
  const profiles = useQuery({ queryKey: ['profiles'], queryFn: () => api<Profile[]>('/profiles') });
  const devices = useQuery({ queryKey: ['devices'], queryFn: () => api<Device[]>('/devices') });
  const names = callNames({
    tools: tools.data,
    connections: connections.data,
    profiles: profiles.data,
    devices: devices.data,
  });
  const update = (patch: ActivitySearch) =>
    void navigate({ search: (previous) => ({ ...previous, callId: undefined, ...patch }) });
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">ACTIVITY</span>
          <h1>运行记录</h1>
          <p>按 Agent、连接和设备定位调用，查看实际身份与执行阶段。</p>
        </div>
      </div>
      <Feedback
        error={calls.error ?? tools.error ?? connections.error ?? profiles.error ?? devices.error}
      />
      <ActivityFilters
        values={filters}
        options={{
          tools: tools.data ?? [],
          connections: connections.data ?? [],
          profiles: profiles.data ?? [],
          devices: devices.data ?? [],
        }}
        onChange={update}
      />
      <Card className="panel">
        <div className="panel-heading">
          <h2>最近 100 次匹配调用</h2>
          <span className="label">每 5 秒刷新</span>
        </div>
        {calls.isPending ? (
          <p className="quiet-empty" role="status">
            正在读取调用记录…
          </p>
        ) : null}
        {calls.data?.length ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>状态</TableHead>
                <TableHead>工具 / 执行位置</TableHead>
                <TableHead>开始时间</TableHead>
                <TableHead>耗时</TableHead>
                <TableHead>诊断 / 操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {calls.data.map((call) => (
                <CallRow
                  key={call.id}
                  call={call}
                  names={names}
                  onOpen={() => update({ callId: call.id })}
                />
              ))}
            </TableBody>
          </Table>
        ) : calls.isSuccess ? (
          <Empty>没有匹配的调用。可调整筛选条件，或前往工具目录执行一次调用。</Empty>
        ) : null}
      </Card>
      {filters.callId ? (
        <CallDetail
          id={filters.callId}
          names={names}
          onClose={() => update({ callId: undefined })}
        />
      ) : null}
    </>
  );
}
