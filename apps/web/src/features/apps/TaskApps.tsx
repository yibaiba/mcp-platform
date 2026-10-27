import { lazy, Suspense, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, json } from '../../lib/api.js';
const AppHost = lazy(() => import('./AppHost.js').then((module) => ({ default: module.AppHost })));
export function TaskApps({ taskId }: { taskId: string }) {
  const apps = useQuery({
    queryKey: ['apps', taskId],
    queryFn: () => api<{ id: string }[]>(`/apps?taskId=${taskId}`),
    refetchInterval: 2000,
  });
  return (
    <>
      {apps.data?.map((app) => (
        <TaskApp key={app.id} id={app.id} />
      ))}
    </>
  );
}
function TaskApp({ id }: { id: string }) {
  const send = useCallback(
    (text: string) => api(`/apps/${id}/send`, { method: 'POST', body: json({ text }) }),
    [id],
  );
  return (
    <Suspense fallback={<p>加载 App…</p>}>
      <AppHost sessionId={id} onSend={send} />
    </Suspense>
  );
}
