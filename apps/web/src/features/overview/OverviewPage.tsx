import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { AlertTriangle, ChevronRight, Network, Plus } from 'lucide-react';
import { Card } from '../../components/ui/card.js';
import { Button } from '../../components/ui/button.js';
import { Hint } from '../../components/ui/tooltip.js';
import { api, type Connection, type Device, type Tool, type Call } from '../../lib/api.js';
import {
  date,
  Empty,
  ListSkeleton,
  QueryError,
  relativeTime,
  Status,
} from '../../components/shared/Controls.js';
import { PageHeader } from '../../components/shared/PageHeader.js';
import { SetupChecklist } from '../onboarding/SetupChecklist.js';
export default function OverviewPage() {
  const connections = useQuery({
    queryKey: ['connections'],
    queryFn: () => api<Connection[]>('/connections'),
  });
  const devices = useQuery({
    queryKey: ['devices'],
    queryFn: () => api<Device[]>('/devices'),
    refetchInterval: 15_000,
  });
  const tools = useQuery({ queryKey: ['tools'], queryFn: () => api<Tool[]>('/tools') });
  const calls = useQuery({ queryKey: ['calls'], queryFn: () => api<Call[]>('/calls?limit=5') });
  const failing = connections.data?.filter((connection) => connection.status === 'error') ?? [];
  const activeDevices = devices.data?.filter((device) => !device.revoked) ?? [];
  const offline = activeDevices.filter((device) => !device.online);
  const failed = connections.error ?? devices.error ?? tools.error ?? calls.error;
  return (
    <>
      <PageHeader
        title="概览"
        actions={
          <Button render={<Link to="/connections" hash="connector-catalog" />}>
            <Plus aria-hidden="true" />
            添加连接
          </Button>
        }
      />
      <QueryError
        error={failed}
        onRetry={() =>
          Promise.all([connections.refetch(), devices.refetch(), tools.refetch(), calls.refetch()])
        }
      />
      {failing.length || offline.length ? (
        <div className="attention" role="status">
          <AlertTriangle size={16} aria-hidden="true" />
          <span className="grow">
            {[
              failing.length ? `${failing.length} 个连接出错` : '',
              offline.length ? `${offline.length} 台设备离线` : '',
            ]
              .filter(Boolean)
              .join(' · ')}
          </span>
          <Link to={failing.length ? '/connections' : '/devices'}>
            查看 <ChevronRight size={14} aria-hidden="true" />
          </Link>
        </div>
      ) : null}
      <SetupChecklist />
      <div className="overview-lists">
        <Card className="panel">
          <div className="panel-heading">
            <h2>连接</h2>
            <Link to="/connections">
              全部 <ChevronRight size={14} aria-hidden="true" />
            </Link>
          </div>
          {connections.isPending ? <ListSkeleton rows={3} /> : null}
          {connections.data?.length ? (
            connections.data.slice(0, 5).map((connection) => (
              <Link
                to="/connections"
                hash={`connection-${connection.id}`}
                className="row row-link"
                key={connection.id}
              >
                <strong className="grow truncate">{connection.name}</strong>
                <Status value={connection.status} />
                <small className="row-meta">
                  {tools.data
                    ? `${tools.data.filter((tool) => tool.connectionId === connection.id).length} 工具`
                    : ''}
                </small>
              </Link>
            ))
          ) : connections.isSuccess ? (
            <Empty
              icon={Network}
              title="添加第一个连接"
              action={
                <Button
                  variant="outline"
                  render={<Link to="/connections" hash="connector-catalog" />}
                >
                  添加连接
                </Button>
              }
            />
          ) : null}
        </Card>
        <Card className="panel">
          <div className="panel-heading">
            <h2>最近调用</h2>
            <Link to="/activity">
              全部 <ChevronRight size={14} aria-hidden="true" />
            </Link>
          </div>
          {calls.isPending ? <ListSkeleton rows={3} /> : null}
          {calls.data?.length ? (
            calls.data.map((call) => (
              <Link
                to="/activity"
                search={{ callId: call.id }}
                className="row row-link"
                key={call.id}
              >
                <Status value={call.status} />
                <code className="grow truncate">
                  {tools.data?.find((t) => t.id === call.toolId)?.name ?? call.toolId}
                </code>
                <Hint content={date(call.startedAt)}>
                  <small className="row-meta" tabIndex={0}>
                    {relativeTime(call.startedAt)}
                  </small>
                </Hint>
              </Link>
            ))
          ) : calls.isSuccess ? (
            <Empty
              title="暂无调用"
              action={
                <Button variant="outline" render={<Link to="/tools" />}>
                  去测试
                </Button>
              }
            />
          ) : null}
        </Card>
      </div>
      <p className="inline-stats">
        连接 {connections.data?.length ?? '—'} · 设备{' '}
        {devices.data ? `${activeDevices.length - offline.length}/${activeDevices.length}` : '—'}{' '}
        在线 · 工具 {tools.data?.length ?? '—'}
      </p>
    </>
  );
}
