import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import {
  api,
  type Profile,
  type Tool,
  type ContentEntry,
  type Artifact,
  type Connection,
  type Skill,
} from '../../lib/api.js';
import { Card } from '../../components/ui/card.js';
import { Button } from '../../components/ui/button.js';
import { Code, Feedback } from '../../components/shared/Controls.js';
import { Disclosure } from '../../components/shared/Disclosure.js';
import { IdentitySettings } from './IdentitySettings.js';
import { RequestableSettings } from './RequestableSettings.js';
import { ApprovalPanel } from '../tasks/ApprovalPanel.js';
export function WorkspacePage({ profileId, onBack }: { profileId: string; onBack: () => void }) {
  const profile = useQuery({
    queryKey: ['profile', profileId],
    queryFn: () => api<Profile>(`/profiles/${profileId}`),
  });
  const connections = useQuery({
    queryKey: ['connections'],
    queryFn: () => api<Connection[]>('/connections'),
  });
  const tools = useQuery({ queryKey: ['tools'], queryFn: () => api<Tool[]>('/tools') });
  const content = useQuery({
    queryKey: ['catalog'],
    queryFn: () => api<ContentEntry[]>('/catalog'),
  });
  const artifacts = useQuery({
    queryKey: ['artifacts'],
    queryFn: () => api<Artifact[]>('/artifacts'),
  });
  const skills = useQuery({ queryKey: ['skills'], queryFn: () => api<Skill[]>('/skills') });
  const tasks = useQuery({
    queryKey: ['workspace-tasks', profileId],
    queryFn: () =>
      api<{ id: string; profileId: string; prompt: string; status: string }[]>('/tasks'),
    refetchInterval: 3000,
  });
  const current = profile.data;
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">AGENT WORKSPACE</span>
          <h1>{current?.name ?? 'Agent 工作空间'}</h1>
          <p>配置此 Agent 的账号身份、执行设备和访问权限；修订 {current?.revision ?? '—'}。</p>
        </div>
        <Button variant="outline" onClick={onBack}>
          返回 Agent 配置
        </Button>
      </div>
      <Feedback
        error={
          profile.error ??
          connections.error ??
          tools.error ??
          content.error ??
          artifacts.error ??
          skills.error ??
          tasks.error
        }
      />
      {current ? (
        <div className="space-y-5">
          <Card className="panel padded">
            <h2>长期授权与版本</h2>
            <Code
              value={{
                工具: tools.data
                  ?.filter((t) => current.toolIds.includes(t.id))
                  .map((t) => ({ name: t.name, id: t.id, connection: t.connectionId })),
                内容: current.contentIds,
                Skills: skills.data
                  ?.filter((s) => current.skillVersionIds.includes(s.id))
                  .map((s) => ({ name: s.name, digest: s.digest })),
                产物: artifacts.data?.filter((a) => current.artifactIds.includes(a.id)),
              }}
            />
            <div className="flex flex-wrap gap-4">
              <Link to="/tools" search={{ profileId: current.id }}>
                以此 Agent 测试工具和内容
              </Link>
              <Link to="/activity" search={{ profileId: current.id }}>
                查看此 Agent 的调用记录
              </Link>
            </div>
          </Card>
          <Card className="panel padded">
            <h2>身份与执行位置</h2>
            {connections.data?.map((connection) => (
              <Disclosure
                key={connection.id}
                title={`${connection.name} · ${connection.deviceId ?? '平台主机'}`}
              >
                <IdentitySettings
                  key={`${connection.id}:${current.revision}`}
                  profile={current}
                  connection={connection}
                />
              </Disclosure>
            ))}
          </Card>
          <Card className="panel padded">
            <h2>可申请范围</h2>
            <RequestableSettings
              key={current.revision}
              profile={current}
              tools={tools.data ?? []}
              content={content.data ?? []}
              artifacts={artifacts.data ?? []}
            />
          </Card>
          <ApprovalPanel profileId={profileId} />
          <Card className="panel padded">
            <h2>任务</h2>
            {tasks.data
              ?.filter((t) => t.profileId === profileId)
              .map((task) => (
                <p key={task.id}>
                  <a href={`/tasks?task=${task.id}`}>{task.prompt}</a> · {task.status}
                </p>
              ))}
          </Card>
        </div>
      ) : null}
    </>
  );
}
