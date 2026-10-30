import { useState } from 'react';
import { Button } from '../../components/ui/button.js';
import { Action, Status, ListSkeleton } from '../../components/shared/Controls.js';
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
  const [cursor, setCursor] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ count: number; token: string } | null>(null);
  const search = new URLSearchParams(
    Object.entries(filters).filter(([key, value]) => key !== 'callId' && Boolean(value)) as [
      string,
      string,
    ][],
  );
  for (const field of ['from', 'before']) {
    const value = search.get(field);
    if (value && Number.isFinite(Date.parse(value)))
      search.set(field, new Date(value).toISOString());
  }
  const queryString = search.toString();
  const calls = useQuery({
    queryKey: ['calls', queryString, cursor],
    queryFn: () =>
      api<{ items: Call[]; nextCursor: string | null }>(
        `/activity/calls?${queryString}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      ),
    refetchInterval: 5000,
  });
  const stats = useQuery({
    queryKey: ['call-stats', queryString],
    queryFn: () =>
      api<{ status: string; count: number; meanDurationMs: number | null }[]>(
        `/activity/calls/stats?${queryString}`,
      ),
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
  const update = (patch: ActivitySearch) => {
    setCursor(null);
    setPreview(null);
    void navigate({ search: (previous) => ({ ...previous, callId: undefined, ...patch }) });
  };
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
      <Feedback error={stats.error} />
      <div className="overview-grid">
        {stats.data?.map((row) => (
          <Card className="p-4" key={row.status}>
            <Status value={row.status} />
            <strong>{row.count} 次</strong>
            <small>
              平均耗时 {row.meanDurationMs === null ? '—' : `${Math.round(row.meanDurationMs)} ms`}
            </small>
          </Card>
        ))}
      </div>
      <div className="my-4 flex flex-wrap items-center gap-3">
        <Action
          action={async () =>
            setPreview(
              await api('/activity/calls/cleanup/preview', {
                method: 'POST',
                body: JSON.stringify(Object.fromEntries(new URLSearchParams(search))),
              }),
            )
          }
        >
          预览清理当前范围
        </Action>
        {preview ? (
          <>
            <span>将清理 {preview.count} 条已结束记录，运行和等待回答的调用保留。</span>
            <Action
              danger
              confirmation={{
                title: `清理 ${preview.count} 条已结束记录？`,
                description: '运行中和等待中的调用会保留。',
                confirmLabel: '清理',
              }}
              action={async () => {
                await api('/activity/calls/cleanup', {
                  method: 'POST',
                  body: JSON.stringify({ token: preview.token }),
                });
                setPreview(null);
                setCursor(null);
              }}
            >
              执行清理
            </Action>
          </>
        ) : null}
      </div>
      <Card className="panel">
        <div className="panel-heading">
          <h2>调用记录 · 每页 50 条</h2>
          <span className="label">每 5 秒刷新</span>
        </div>
        {calls.isPending ? <ListSkeleton /> : null}
        {calls.data?.items.length ? (
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
              {calls.data.items.map((call) => (
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
      <div className="my-4 flex flex-wrap items-center gap-3">
        <Button variant="outline" disabled={!cursor} onClick={() => setCursor(null)}>
          返回第一页
        </Button>
        <Button
          variant="outline"
          disabled={!calls.data?.nextCursor}
          onClick={() => setCursor(calls.data!.nextCursor)}
        >
          下一页
        </Button>
      </div>
    </>
  );
}
