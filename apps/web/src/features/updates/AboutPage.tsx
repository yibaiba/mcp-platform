import { useQuery } from '@tanstack/react-query';
import { api, json } from '../../lib/api.js';
import { Action, Feedback } from '../../components/shared/Controls.js';
export type VersionStatus = {
  build: { version: string; commit: string; builtAt: string | null; release: boolean };
  scheduled: boolean;
  stale: boolean;
  result: {
    state: string;
    error?: string;
    checkedAt: string;
    previousStale?: boolean;
    release?: { tag_name: string; published_at: string; body: string; html_url: string };
  } | null;
};
const states: Record<string, string> = {
  no_release: '暂无稳定 Release',
  failed: '检查失败',
  rate_limited: 'GitHub 请求受到限流',
  available: '有新版本可用',
  up_to_date: '当前发行版本已是最新',
  development: '开发构建，不与发行版本判断先后',
};
export default function AboutPage() {
  const version = useQuery({
    queryKey: ['version'],
    queryFn: () => api<VersionStatus>('/version'),
  });
  const me = useQuery({ queryKey: ['me'], queryFn: () => api<{ role: string }>('/me') });
  const devices = useQuery({
    queryKey: ['devices'],
    queryFn: () => api<{ id: string; name: string; version: string | null }[]>('/devices'),
  });
  const info = version.data;
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>关于与更新</h1>
          <p>MCP Platform · yibaiba/mcp-platform</p>
        </div>
      </div>
      <Feedback error={version.error ?? me.error ?? devices.error} />
      {info ? (
        <section className="panel space-y-4 p-5 sm:p-6">
          <h2>
            {info.build.release ? info.build.version : `dev · ${info.build.commit.slice(0, 8)}`}
          </h2>
          <p style={{ overflowWrap: 'anywhere' }}>
            提交：{info.build.commit}
            <br />
            构建时间：
            {info.build.builtAt ? new Date(info.build.builtAt).toLocaleString() : '尚未构建'}
          </p>
          <p role="status">
            {info.stale ? '网络配置已变化，已有结果已过期。' : ''}
            {info.result ? (states[info.result.state] ?? info.result.state) : '尚未检查更新'}
          </p>
          {info.result?.error ? <p role="alert">{info.result.error}</p> : null}
          {info.result?.checkedAt ? (
            <p>上次检查：{new Date(info.result.checkedAt).toLocaleString()}</p>
          ) : null}
          {me.data?.role === 'admin' ? (
            <div className="flex flex-wrap gap-2">
              <Action action={() => api('/admin/platform-update', { method: 'POST' })}>
                检查平台更新
              </Action>
              <Action
                action={() =>
                  api('/admin/platform-update', {
                    method: 'PATCH',
                    body: json({ scheduled: !info.scheduled }),
                  })
                }
              >
                {info.scheduled ? '关闭每 24 小时检查' : '开启每 24 小时检查'}
              </Action>
            </div>
          ) : (
            <p>管理员可以发起检查或开启定时检查。</p>
          )}
          <p className="text-sm text-muted-foreground">
            检查只读取 GitHub Releases，不下载或安装升级程序，不触发发布。
          </p>
          {info.result?.release ? (
            <article className="space-y-3">
              <h3>{info.result.release.tag_name}</h3>
              {info.result.previousStale ? <p>上次成功查询的发布说明，已过期。</p> : null}
              <p>
                {new Date(info.result.release.published_at).toLocaleString()} ·{' '}
                <a href={info.result.release.html_url} target="_blank" rel="noreferrer">
                  查看 GitHub Release
                </a>
              </p>
              <pre className="whitespace-pre-wrap break-words font-sans text-sm">
                {info.result.release.body || '此版本没有发布说明。'}
              </pre>
            </article>
          ) : null}
        </section>
      ) : version.isPending ? (
        <p>正在读取版本信息…</p>
      ) : null}
      <section className="panel mt-4 space-y-3 p-5 sm:p-6">
        <h2>设备连接器版本</h2>
        {devices.data?.length ? (
          devices.data.map((device) => (
            <p key={device.id}>
              {device.name} · {device.version ?? '尚未上报版本'}
            </p>
          ))
        ) : (
          <p>尚无设备版本记录。</p>
        )}
      </section>
    </>
  );
}
