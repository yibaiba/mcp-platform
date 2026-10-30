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
  Feedback,
  Field,
  Form,
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
        title="内置 Agent"
        info="按所选 Agent 配置使用工具和 Skills；只有执行推理任务才需要模型。"
      />
      <Feedback error={me.error ?? profiles.error ?? tasks.error} />
      {!me.data?.piEnabled ? (
        <Card className="panel padded">
          <h2>内置 Agent 任务尚未启用</h2>
          <p>
            MCP 连接和 Pi 桥接可直接使用，无需配置模型。仅执行此页的 Agent
            任务需要启用推理并配置模型。
          </p>
        </Card>
      ) : (
        <Card className="panel padded">
          <Form
            label="执行任务"
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
      )}
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
        ) : (
          <Empty>还没有任务记录。</Empty>
        )}
      </Card>
    </>
  );
}
