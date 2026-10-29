import { useQuery } from '@tanstack/react-query';
import type { NetworkView } from '@platform/contracts';
import { api, json } from '../../lib/api.js';
import { Feedback } from '../../components/shared/Controls.js';
import { NetworkEditor } from './NetworkEditor.js';
export default function NetworkPage() {
  const query = useQuery({
    queryKey: ['network-settings'],
    queryFn: () => api<NetworkView>('/admin/network-settings'),
  });
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>网络与安装源</h1>
          <p>平台代理、公共包镜像与 GitHub 加速</p>
        </div>
      </div>
      <Feedback error={query.error} />
      {query.data ? (
        <section className="panel p-5 sm:p-6">
          <NetworkEditor
            initial={query.data}
            save={(value) => api('/admin/network-settings', { method: 'PUT', body: json(value) })}
            check={() => api('/admin/network-settings/check', { method: 'POST' })}
          />
        </section>
      ) : query.isPending ? (
        <p>正在读取设置…</p>
      ) : null}
    </>
  );
}
