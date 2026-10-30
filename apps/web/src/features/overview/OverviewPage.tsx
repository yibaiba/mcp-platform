import { useId, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  AlertTriangle,
  ChevronRight,
  Monitor,
  Network,
  Plus,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
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
function StatTile({
  icon: Icon,
  label,
  value,
  detail,
  hero,
  children,
}: {
  icon: LucideIcon;
  label: string;
  value?: number;
  detail?: string;
  hero?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className={hero ? 'stat-tile is-hero' : 'stat-tile'}>
      <span className="stat-tile-icon" aria-hidden="true">
        <Icon size={16} />
      </span>
      <span className="stat-tile-label">{label}</span>
      <strong className="stat-tile-value">{value ?? '—'}</strong>
      <span className="stat-tile-detail">{detail ?? ' '}</span>
      {children ? (
        <span className="stat-tile-art" aria-hidden="true">
          {children}
        </span>
      ) : null}
    </div>
  );
}
type NodeState = 'ok' | 'error' | 'idle';
const nodeColor: Record<NodeState, string> = {
  ok: 'var(--success)',
  error: 'var(--destructive)',
  idle: 'var(--subtle-foreground)',
};
/** Decorative hub-and-spoke map: the platform in the middle, one node per connection. */
function ConnectionMap({ states }: { states: NodeState[] }) {
  const id = useId();
  const nodes = states.slice(0, 8);
  const cx = 160;
  const cy = 60;
  return (
    <svg viewBox="0 0 320 120" fill="none">
      <defs>
        <linearGradient id={`${id}-line`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="var(--primary)" stopOpacity="0.55" />
          <stop offset="100%" stopColor="var(--brand-2)" stopOpacity="0.25" />
        </linearGradient>
        <radialGradient id={`${id}-hub`}>
          <stop offset="0%" stopColor="var(--primary)" stopOpacity="0.35" />
          <stop offset="100%" stopColor="var(--primary)" stopOpacity="0" />
        </radialGradient>
      </defs>
      <g stroke="var(--border)" strokeWidth="1" opacity="0.6">
        {[40, 80, 120, 200, 240, 280].map((x) => (
          <circle key={x} cx={x} cy={cy} r="1" fill="var(--border)" />
        ))}
      </g>
      {nodes.map((state, index) => {
        const angle = -Math.PI / 2 + (2 * Math.PI * index) / nodes.length + Math.PI / nodes.length;
        const x = cx + Math.cos(angle) * 128;
        const y = cy + Math.sin(angle) * 44;
        return (
          <g key={index}>
            <path
              d={`M${cx} ${cy} Q ${(cx + x) / 2} ${(cy + y) / 2 - 12} ${x} ${y}`}
              stroke={`url(#${id}-line)`}
              strokeWidth="1.25"
            />
            <circle cx={x} cy={y} r="9" fill="var(--card)" stroke="var(--border)" />
            <circle cx={x} cy={y} r="3.5" fill={nodeColor[state]} />
          </g>
        );
      })}
      <circle cx={cx} cy={cy} r="34" fill={`url(#${id}-hub)`} />
      <rect
        x={cx - 14}
        y={cy - 14}
        width="28"
        height="28"
        rx="8"
        fill="var(--card)"
        stroke="var(--primary)"
        strokeOpacity="0.6"
      />
      <circle cx={cx} cy={cy} r="4" fill="var(--primary)" />
    </svg>
  );
}
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
  const userConnections = connections.data?.filter((connection) => connection.source !== 'library');
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
      <div className="stat-tiles" aria-label="统计">
        <StatTile
          hero
          icon={Network}
          label="连接"
          value={userConnections?.length}
          detail={
            userConnections
              ? `${userConnections.filter((c) => c.status === 'connected').length} 个已连接`
              : undefined
          }
        >
          {userConnections?.length ? (
            <ConnectionMap
              states={userConnections.map((c) =>
                c.status === 'connected' ? 'ok' : c.status === 'error' ? 'error' : 'idle',
              )}
            />
          ) : null}
        </StatTile>
        <StatTile
          icon={Monitor}
          label="设备在线"
          value={devices.data ? activeDevices.length - offline.length : undefined}
          detail={devices.data ? `共 ${activeDevices.length} 台` : undefined}
        />
        <StatTile
          icon={Wrench}
          label="工具"
          value={tools.data?.length}
          detail={calls.data ? `最近 ${calls.data.length} 次调用` : undefined}
        />
      </div>
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
    </>
  );
}
