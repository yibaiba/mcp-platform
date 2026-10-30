import { PageHeader } from '../../components/shared/PageHeader.js';
import { TaskDetail } from './TaskDetail.js';
import { ApprovalPanel } from './ApprovalPanel.js';
import { InteractionPanel } from '../interactions/InteractionPanel.js';
import { TaskApps } from '../apps/TaskApps.js';
import { Card } from '../../components/ui/card.js';
import { Textarea } from '../../components/ui/textarea.js';
import { SelectControl } from '../../components/shared/SelectControl.js';
import { SelectItem } from '../../components/ui/select.js';
import { useQuery } from '@tanstack/react-query';
import { api, json, type Profile } from '../../lib/api.js';
import {
  Action,
  Code,
  Empty,
  ErrorState,
  Field,
  Form,
  ListSkeleton,
  Status,
  date,
  value,
} from '../../components/shared/Controls.js';
type Task = {
  id: string;
  prompt: string;
  status: string;
  output: string;
  error: string | null;
  createdAt: string;
};
export default function TasksPage() {
  const me = useQuery({ queryKey: ['me'], queryFn: () => api<{ piEnabled: boolean }>('/me') });
  const profiles = useQuery({ queryKey: ['profiles'], queryFn: () => api<Profile[]>('/profiles') });
  const tasks = useQuery({
    queryKey: ['tasks'],
    queryFn: () => api<Task[]>('/tasks'),
    refetchInterval: 3000,
  });
  return (
    <>
      <PageHeader
        title="运行记录"
        info="按所选 Agent 配置使用工具和 Skills；只有执行推理任务才需要模型。"
      />
      <ErrorState title="任务配置加载失败" error={me.error} onRetry={() => me.refetch()} />
      <ErrorState
        title="Agent 配置加载失败"
        error={profiles.error}
        onRetry={() => profiles.refetch()}
      />
      {me.isPending ? <ListSkeleton rows={2} /> : null}
      {me.isSuccess && !me.data.piEnabled ? (
        <Card className="panel padded">
          <h2>内置 Agent 任务尚未启用</h2>
          <p>
            MCP 连接和 Pi 桥接可直接使用，无需配置模型。仅执行此页的 Agent
            任务需要启用推理并配置模型。
          </p>
        </Card>
      ) : me.isSuccess && me.data.piEnabled ? (
        <Card className="panel padded">
          <Form
            label="执行任务"
            disabled={!profiles.isSuccess}
            submit={async (data) =>
              api('/tasks', {
                method: 'POST',
                body: json({ profileId: value(data, 'profileId'), prompt: value(data, 'prompt') }),
              })
            }
          >
            <Field label="Agent 配置">
              <SelectControl name="profileId" required>
                <SelectItem value="">选择配置</SelectItem>
                {profiles.data?.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectControl>
            </Field>
            <Field label="任务内容">
              <Textarea name="prompt" rows={5} required placeholder="描述你想完成的任务…" />
            </Field>
          </Form>
        </Card>
      ) : null}
      <InteractionPanel />
      {new URLSearchParams(window.location.search).get('task') ? (
        <TaskDetail id={new URLSearchParams(window.location.search).get('task')!} />
      ) : (
        <ApprovalPanel />
      )}
      <Card className="panel">
        <div className="panel-heading">
          <h2>任务记录</h2>
        </div>
        <ErrorState title="任务记录加载失败" error={tasks.error} onRetry={() => tasks.refetch()} />
        {tasks.isPending ? <ListSkeleton rows={3} /> : null}
        {tasks.data?.length ? (
          tasks.data.map((task) => (
            <div key={task.id} className="connection-row">
              <div className="row">
                <Status value={task.status} />
                <a className="grow" href={`/tasks?task=${task.id}`}>
                  {task.prompt}
                </a>
                {task.status === 'running' ? (
                  <Action action={() => api(`/tasks/${task.id}/cancel`, { method: 'POST' })}>
                    取消
                  </Action>
                ) : null}
              </div>
              <small>{date(task.createdAt)}</small>
              <TaskApps taskId={task.id} />
              {task.output ? <Code value={task.output} /> : null}
              {task.error ? <div className="error">{task.error}</div> : null}
            </div>
          ))
        ) : tasks.isSuccess ? (
          <Empty>还没有任务记录。</Empty>
        ) : null}
      </Card>
    </>
  );
}
