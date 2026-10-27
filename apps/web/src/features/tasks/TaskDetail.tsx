import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { api, type Call, type Artifact } from '../../lib/api.js';
import { Card } from '../../components/ui/card.js';
import { Action, Code, Feedback, Status } from '../../components/shared/Controls.js';
import { TaskApps } from '../apps/TaskApps.js';
import { ApprovalPanel } from './ApprovalPanel.js';
import { HandoffPanel } from './HandoffPanel.js';
type Detail = {
  id: string;
  profileId: string;
  revision: number;
  status: string;
  prompt: string;
  output: string;
  error?: string;
  calls: Call[];
  artifacts: Artifact[];
  events: unknown[];
  interactions: unknown[];
  handoffId?: string;
};
export function TaskDetail({ id }: { id: string }) {
  const query = useQueryClient();
  const task = useQuery({
    queryKey: ['task', id],
    queryFn: () => api<Detail>(`/tasks/${id}`),
    refetchInterval: 3000,
  });
  useEffect(() => {
    const stream = new EventSource('/api/v1/tasks/events', { withCredentials: true });
    const refresh = () => {
      void query.invalidateQueries({ queryKey: ['task', id] });
    };
    // Reconnection always reads the durable snapshot. Events never overwrite local task state.
    stream.addEventListener('ready', refresh);
    stream.addEventListener('task', refresh);
    return () => stream.close();
  }, [id, query]);
  return (
    <>
      <Feedback error={task.error} />
      {task.data ? (
        <>
          <Card className="panel padded">
            <h2>{task.data.prompt}</h2>
            <Status value={task.data.status} />
            <small>
              Agent {task.data.profileId} · 修订 {task.data.revision} · 交接来源{' '}
              {task.data.handoffId ?? '无'}
            </small>
            {['running', 'waiting_authorization'].includes(task.data.status) ? (
              <Action action={() => api(`/tasks/${id}/cancel`, { method: 'POST' })}>
                取消任务
              </Action>
            ) : null}
            <Code value={task.data.output} />
            {task.data.error ? <p className="error">{task.data.error}</p> : null}
            <TaskApps taskId={id} />
            <h3>工具调用与阶段</h3>
            {task.data.calls.map((call) => (
              <Code key={call.id} value={call} />
            ))}
            <h3>上游交互来源</h3>
            <Code value={task.data.interactions} />
            <h3>产物</h3>
            <Code value={task.data.artifacts} />
            <h3>持久阶段事件</h3>
            <Code value={task.data.events} />
          </Card>
          <ApprovalPanel taskId={id} />
          <HandoffPanel taskId={id} artifacts={task.data.artifacts} />
        </>
      ) : null}
    </>
  );
}
