import { useQuery } from '@tanstack/react-query';
import { api, json } from '../../lib/api.js';
import { Action, Feedback, date } from '../../components/shared/Controls.js';
type Result = {
  state: string;
  error?: string;
  checkedAt?: string;
  package?: { name: string; configured: string; source: string };
  latest?: string | null;
  updateAvailable?: boolean | null;
  lastSuccess?: Result;
};
type Status = {
  declaration?: Result['package'];
  scheduled: boolean;
  stale: boolean;
  result: Result | null;
  runtimeVersion: string | null;
  runtimeVersionReason: string;
};
export function PackageUpdate({ id }: { id: string }) {
  const path = `/connections/${id}/package-update`;
  const query = useQuery({ queryKey: ['package-update', id], queryFn: () => api<Status>(path) });
  const result = query.data?.result;
  const declared = query.data?.declaration;
  const success = result?.state === 'checked' ? result : result?.lastSuccess;
  return (
    <section className="space-y-3" aria-label="MCP 包更新">
      <h3>包版本与更新</h3>
      <Feedback error={query.error} />
      <div className="update-summary" role="status">
        <strong>{updateSummary(query)}</strong>
        <span>上次检查：{date(result?.checkedAt ?? null)}</span>
        <span>已验证运行版本：{query.data?.runtimeVersion ?? '未知'}</span>
      </div>
      {query.data?.runtimeVersionReason ? (
        <details className="technical-details">
          <summary>运行版本如何确认</summary>
          <p>{query.data.runtimeVersionReason}</p>
        </details>
      ) : null}
      {query.data?.stale ? <p>连接或网络配置已变化，历史检查结果已过期。</p> : null}
      {result?.state === 'failed' ? (
        <p role="alert">检查失败：{result.error}。历史成功结果仅供参考，已过期。</p>
      ) : null}
      {declared ? (
        <p style={{ overflowWrap: 'anywhere' }}>
          配置：{declared.name} · {declared.configured}
          <br />
          来源：{declared.source}
        </p>
      ) : null}
      {success?.package ? (
        <dl className="grid gap-2 text-sm" style={{ overflowWrap: 'anywhere' }}>
          <div>
            <dt>检查时的包 / 配置版本</dt>
            <dd>
              {success.package.name} · {success.package.configured}
            </dd>
          </div>
          <div>
            <dt>可用稳定版本</dt>
            <dd>
              {success.latest ?? '当前来源没有稳定版本'}
              {success.updateAvailable ? ' · 有更新可用' : ''}
            </dd>
          </div>
          <div>
            <dt>实际检查来源</dt>
            <dd>{success.package.source}</dd>
          </div>
          <div>
            <dt>检查时间</dt>
            <dd>{success.checkedAt ? new Date(success.checkedAt).toLocaleString() : '尚未检查'}</dd>
          </div>
        </dl>
      ) : query.isSuccess ? (
        <p>尚无成功检查结果。检查不会安装包、启动 MCP 或调用模型。</p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Action action={() => api(path, { method: 'POST' })}>手动检查更新</Action>
        {query.data ? (
          <Action
            action={() =>
              api(path, { method: 'PATCH', body: json({ scheduled: !query.data!.scheduled }) })
            }
          >
            {query.data.scheduled ? '关闭每 24 小时检查' : '开启每 24 小时检查'}
          </Action>
        ) : null}
      </div>
      <p className="text-xs text-muted-foreground">仅提示稳定版本，不自动升级或修改固定版本。</p>
    </section>
  );
}

function updateSummary(query: { isPending: boolean; isError: boolean; data?: Status }) {
  if (query.isPending) return '正在读取包版本…';
  if (query.isError) return '包版本信息读取失败';
  const result = query.data?.result;
  if (result?.state === 'failed') return '本次检查失败';
  if (query.data?.stale) return '历史检查已过期';
  const success = result?.state === 'checked' ? result : result?.lastSuccess;
  if (!success) return '尚未检查更新';
  if (success.updateAvailable) return '有稳定更新可用';
  if (success.updateAvailable === false) return '当前配置未发现稳定更新';
  return '已读取来源版本，无法比较';
}
