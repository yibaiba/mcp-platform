import { PageHeader } from '../../components/shared/PageHeader.js';
import { useState } from 'react';
import { Button } from '../../components/ui/button.js';
import { Action, ListSkeleton, statusText } from '../../components/shared/Controls.js';
import { History, MoreHorizontal } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../../components/ui/dropdown-menu.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog.js';
import { Link } from '@tanstack/react-router';
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
  // Cursors of the pages before the current one; length + 1 is the page number.
  const [history, setHistory] = useState<(string | null)[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [cleaning, setCleaning] = useState(false);
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
    setHistory([]);
    setPreview(null);
    void navigate({ search: (previous) => ({ ...previous, callId: undefined, ...patch }) });
  };
  const total = stats.data?.reduce((sum, row) => sum + row.count, 0) ?? 0;
  const timed = stats.data?.filter((row) => row.meanDurationMs !== null) ?? [];
  const mean = timed.length
    ? Math.round(
        timed.reduce((sum, row) => sum + row.meanDurationMs! * row.count, 0) /
          Math.max(
            1,
            timed.reduce((sum, row) => sum + row.count, 0),
          ),
      )
    : null;
  const previewCleanup = async () =>
    setPreview(
      await api('/activity/calls/cleanup/preview', {
        method: 'POST',
        body: JSON.stringify(Object.fromEntries(new URLSearchParams(search))),
      }),
    );
  return (
    <>
      <PageHeader
        title="运行记录"
        actions={
          <DropdownMenu>
            <DropdownMenuTrigger
              render={<Button variant="ghost" size="icon" />}
              aria-label="运行记录更多操作"
            >
              <MoreHorizontal aria-hidden="true" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-44">
              <DropdownMenuItem
                onClick={() => {
                  setPreview(null);
                  setCleaning(true);
                }}
              >
                清理当前范围的记录…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        }
      />
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
      >
        <p className="filter-count" aria-label="调用统计">
          {stats.data
            ? [
                `共 ${total}`,
                ...stats.data.map((row) => `${statusText(row.status)} ${row.count}`),
                mean === null ? '' : `平均 ${mean} ms`,
              ]
                .filter(Boolean)
                .join(' · ')
            : null}
        </p>
      </ActivityFilters>
      <Feedback error={stats.error} />
      <Card className="panel">
        {calls.isPending ? <ListSkeleton /> : null}
        {calls.data?.items.length ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>状态</TableHead>
                <TableHead>工具 / 运行位置</TableHead>
                <TableHead>开始</TableHead>
                <TableHead>耗时</TableHead>
                <TableHead>
                  <span className="sr-only">诊断 / 操作</span>
                </TableHead>
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
          <Empty
            icon={History}
            title="没有匹配的调用"
            action={
              <Button variant="outline" render={<Link to="/tools" />}>
                去测试工具
              </Button>
            }
          />
        ) : null}
      </Card>
      {filters.callId ? (
        <CallDetail
          id={filters.callId}
          names={names}
          onClose={() => update({ callId: undefined })}
        />
      ) : null}
      {history.length || calls.data?.nextCursor ? (
        <nav className="pagination" aria-label="分页">
          <Button
            variant="outline"
            disabled={!history.length}
            onClick={() => {
              setCursor(history.at(-1) ?? null);
              setHistory(history.slice(0, -1));
            }}
          >
            上一页
          </Button>
          <span aria-current="page">第 {history.length + 1} 页</span>
          <Button
            variant="outline"
            disabled={!calls.data?.nextCursor}
            onClick={() => {
              setHistory([...history, cursor]);
              setCursor(calls.data!.nextCursor);
            }}
          >
            下一页
          </Button>
        </nav>
      ) : null}
      <Dialog
        open={cleaning}
        onOpenChange={(open) => {
          setCleaning(open);
          if (!open) setPreview(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>清理调用记录</DialogTitle>
            <DialogDescription>
              按当前筛选范围清理已结束的记录；运行中和等待回答的调用会保留。
            </DialogDescription>
          </DialogHeader>
          {preview ? <p>将清理 {preview.count} 条已结束记录。</p> : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setCleaning(false)}>
              取消
            </Button>
            {preview ? (
              <Action
                danger
                confirmed
                action={async () => {
                  await api('/activity/calls/cleanup', {
                    method: 'POST',
                    body: JSON.stringify({ token: preview.token }),
                  });
                  setPreview(null);
                  setCursor(null);
                  setHistory([]);
                  setCleaning(false);
                }}
              >
                清理 {preview.count} 条
              </Action>
            ) : (
              <Action action={previewCleanup}>预览清理范围</Action>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
