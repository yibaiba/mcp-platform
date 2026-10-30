import { PageHeader } from '../../components/shared/PageHeader.js';
import { useQuery } from '@tanstack/react-query';
import type { NetworkView } from '@platform/contracts';
import { api, isForbidden, json } from '../../lib/api.js';
import { Forbidden, QueryError, ListSkeleton } from '../../components/shared/Controls.js';
import { NetworkEditor } from './NetworkEditor.js';
export default function NetworkPage() {
  const query = useQuery({
    queryKey: ['network-settings'],
    queryFn: () => api<NetworkView>('/admin/network-settings'),
  });
  if (isForbidden(query.error)) return <Forbidden title="网络与安装源" />;
  return (
    <>
      <PageHeader title="网络与安装源" />
      <QueryError error={query.error} onRetry={() => query.refetch()} />
      {query.data ? (
        <section className="panel network-panel p-5 sm:p-6">
          <NetworkEditor
            initial={query.data}
            save={(value) => api('/admin/network-settings', { method: 'PUT', body: json(value) })}
            check={() => api('/admin/network-settings/check', { method: 'POST' })}
          />
        </section>
      ) : query.isPending ? (
        <ListSkeleton rows={4} />
      ) : null}
    </>
  );
}
