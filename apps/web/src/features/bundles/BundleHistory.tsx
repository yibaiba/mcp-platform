import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api.js';
import { Action, Feedback, Status } from '../../components/shared/Controls.js';
type History = {
  packages: {
    id: string;
    name: string;
    version: string;
    sha256: string;
    removedAt: string | null;
  }[];
  operations: {
    id: string;
    packageId: string;
    state: string;
    phase: string;
    createdAt: string | null;
    connectionId: string | null;
    error: string | null;
    destination: string | null;
  }[];
};
const phases: Record<string, string> = {
  legacy: '旧记录未保存阶段',
  verify: '校验包',
  extract: '写入包文件',
  'device-install': '设备写入与运行时检查',
  runtime: '检查运行时',
  connection: '保存连接',
  discover: '连接与读取目录',
  complete: '完成',
  uninstalled: '已卸载',
};
export function BundleHistory() {
  const query = useQuery({
    queryKey: ['bundle-history'],
    queryFn: () => api<History>('/bundles/mcpb'),
    refetchInterval: (query) =>
      query.state.data?.operations.some((op) => op.state === 'running') ? 2000 : false,
  });
  return (
    <section aria-label="MCPB 安装历史" className="space-y-3">
      <h3>包与安装历史</h3>
      <Feedback error={query.error} />
      <Action action={() => query.refetch()}>刷新安装记录</Action>
      <p>
        刷新页面后可在此查看结果。卸载会关闭连接并移除其 Agent
        授权；清理只删除平台文件，设备上的包文件仍保留。
      </p>
      {query.data?.packages.map((pkg) => (
        <div
          key={pkg.id}
          className="rounded border p-3 space-y-2"
          style={{ overflowWrap: 'anywhere' }}
        >
          <strong>
            {pkg.name} · {pkg.version}
          </strong>
          <details className="technical-details">
            <summary>包校验信息</summary>
            <p>SHA-256：{pkg.sha256}</p>
          </details>
          {pkg.removedAt ? (
            <p>平台包文件已清理</p>
          ) : (
            <Action
              danger
              confirmation={{
                title: `清理“${pkg.name}”包文件？`,
                confirmLabel: '确认清理',
                description:
                  '仅删除未被连接使用的平台包文件；设备上的文件会保留。清理后若需再次安装，必须重新上传。',
              }}
              action={() => api(`/bundles/mcpb/${pkg.id}`, { method: 'DELETE' })}
            >
              清理未使用包文件
            </Action>
          )}
          {query.data.operations
            .filter((op) => op.packageId === pkg.id)
            .map((op) => (
              <div key={op.id} className="border-t pt-2 space-y-2">
                <p>
                  <Status value={op.state} /> · {phases[op.phase] ?? op.phase} ·{' '}
                  {op.createdAt ? new Date(op.createdAt).toLocaleString() : '旧记录未保存安装时间'}
                </p>
                <details className="technical-details">
                  <summary>安装技术详情</summary>
                  <p>
                    操作 {op.id} · {op.destination ?? '旧记录未保存运行位置'}
                  </p>
                </details>
                {op.error ? <p role="alert">{op.error}</p> : null}
                {op.connectionId && op.state !== 'running' ? (
                  <Action
                    danger
                    confirmation={{
                      title: `卸载“${pkg.name}”连接？`,
                      confirmLabel: '确认卸载',
                      description:
                        '将关闭此连接，移除其 Agent 授权及依赖此连接的 Skill 授权。包文件会保留，可单独清理。此操作无法撤销。',
                    }}
                    action={() =>
                      api(`/bundles/mcpb/operations/${op.id}/uninstall`, { method: 'POST' })
                    }
                  >
                    卸载此连接及授权
                  </Action>
                ) : null}
              </div>
            ))}
        </div>
      ))}
      {query.data && !query.data.packages.length ? <p>尚无上传记录。</p> : null}
    </section>
  );
}
