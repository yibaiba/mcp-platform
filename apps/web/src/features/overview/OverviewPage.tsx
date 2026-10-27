import { Card } from '../../components/ui/card.js';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Plug, Monitor, Wrench, ArrowUpRight, Plus, Network } from 'lucide-react';
import { api, type Connection, type Device, type Tool, type Call } from '../../lib/api.js';
import { date, Empty, Feedback, Status } from '../../components/shared/Controls.js';
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
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">WORKSPACE OVERVIEW</span>
          <h1>
            一处连接，随处调用<span className="accent">。</span>
          </h1>
          <p>管理你的 MCP 服务、设备与 Agent，让每个工具各就其位。</p>
        </div>
        <Link className="primary-link" to="/connections">
          <Plus size={17} />
          添加 MCP 连接
        </Link>
      </div>
      <Feedback error={connections.error ?? devices.error ?? tools.error ?? calls.error} />
      <div className="stats">
        {[
          [
            Plug,
            'MCP 连接',
            connections.data?.length,
            `${connections.data?.filter((c) => c.status === 'connected').length ?? 0} 个连接已发现工具`,
          ],
          [
            Monitor,
            '已绑定设备',
            devices.data?.filter((d) => !d.revoked).length,
            `${devices.data?.filter((d) => d.online).length ?? 0} 台设备在线`,
          ],
          [Wrench, '可用工具', tools.data?.length, '通过 Agent 配置分配访问权限'],
        ].map(([Icon, label, count, detail]) => {
          const Symbol = Icon as typeof Plug;
          return (
            <Card className="stat" key={String(label)}>
              <div>
                <span>{String(label)}</span>
                <Symbol size={20} />
              </div>
              <strong>{count == null ? '—' : String(count)}</strong>
              <small>{String(detail)}</small>
            </Card>
          );
        })}
      </div>
      <div className="overview-grid">
        <Card className="panel">
          <div className="panel-heading">
            <h2>连接概况</h2>
            <Link to="/connections">
              查看全部 <ArrowUpRight size={15} />
            </Link>
          </div>
          {connections.data?.length ? (
            <div className="rows">
              {connections.data.slice(0, 5).map((connection) => (
                <div className="row" key={connection.id}>
                  <div className="item-icon">
                    <Plug size={20} />
                  </div>
                  <div className="grow">
                    <strong>{connection.name}</strong>
                    <small>
                      {connection.adapter === 'device'
                        ? '设备执行'
                        : connection.adapter === 'pi'
                          ? 'Pi 桥接'
                          : '平台直连'}{' '}
                      · {connection.transport.toUpperCase()}
                    </small>
                  </div>
                  <Status value={connection.status} />
                </div>
              ))}
            </div>
          ) : (
            <Empty>
              <Network size={38} />
              <h3>从第一个连接开始</h3>
              <p>添加远程 MCP，或连接设备上的本地工具。</p>
              <Link to="/connections">
                创建连接 <ArrowUpRight size={15} />
              </Link>
            </Empty>
          )}
        </Card>
        <SetupChecklist />
      </div>
      <Card className="panel">
        <div className="panel-heading">
          <h2>最近调用</h2>
          <Link to="/activity">
            运行记录 <ArrowUpRight size={15} />
          </Link>
        </div>
        {calls.data?.length ? (
          calls.data.map((call) => (
            <div className="row" key={call.id}>
              <Status value={call.status} />
              <code className="grow truncate">
                {tools.data?.find((t) => t.id === call.toolId)?.name ?? call.toolId}
              </code>
              <small>{date(call.startedAt)}</small>
            </div>
          ))
        ) : (
          <div className="quiet-empty">还没有调用记录。连接 MCP 后，可以在工具目录中测试调用。</div>
        )}
      </Card>
    </>
  );
}
