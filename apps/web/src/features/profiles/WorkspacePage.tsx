import { PageHeader } from '../../components/shared/PageHeader.js';
import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import {
  api,
  type Profile,
  type Tool,
  type ContentEntry,
  type Artifact,
  type Connection,
  type Device,
  type Skill,
} from '../../lib/api.js';
import { Card } from '../../components/ui/card.js';
import { Button } from '../../components/ui/button.js';
import { Badge } from '../../components/ui/badge.js';
import { ArrowLeft, KeyRound, ShieldCheck, Wrench } from 'lucide-react';
import { Code, Empty, Feedback, ListSkeleton } from '../../components/shared/Controls.js';
import { Disclosure } from '../../components/shared/Disclosure.js';
import { IdentitySettings } from './IdentitySettings.js';
import { RequestableSettings } from './RequestableSettings.js';
import { ApprovalPanel } from '../tasks/ApprovalPanel.js';
import { useConnectionNames } from '../connections/useConnectionNames.js';
import { executionLocation } from '../tools/toolCatalog.js';

/**
 * Agent 详情: first what this Agent can use and the names its clients see, with the two things
 * people come here for (编辑权限 / 接入客户端) in plain sight. IDs and raw data live in 高级.
 */
export function WorkspacePage({
  profileId,
  onBack,
  onEdit,
  onAccess,
}: {
  profileId: string;
  onBack: () => void;
  onEdit: (profile: Profile) => void;
  onAccess: (profile: Profile) => void;
}) {
  const profile = useQuery({
    queryKey: ['profile', profileId],
    queryFn: () => api<Profile>(`/profiles/${profileId}`),
  });
  const connections = useQuery({
    queryKey: ['connections'],
    queryFn: () => api<Connection[]>('/connections'),
  });
  const devices = useQuery({ queryKey: ['devices'], queryFn: () => api<Device[]>('/devices') });
  // This Agent's own projection: the exact names its MCP clients get from tools/list.
  const agentTools = useQuery({
    queryKey: ['tools', profileId],
    queryFn: () =>
      api<{ tools: Tool[] }>(`/profiles/${profileId}/agent/catalog`).then((c) => c.tools),
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
  const names = useConnectionNames();
  const deviceById = new Map(devices.data?.map((device) => [device.id, device]));
  const current = profile.data;
  const groups = new Map<string, Tool[]>();
  for (const tool of agentTools.data ?? [])
    groups.set(tool.connectionId, [...(groups.get(tool.connectionId) ?? []), tool]);
  const granted = {
    content: content.data?.filter((entry) => current?.contentIds.includes(entry.id)) ?? [],
    skills: skills.data?.filter((skill) => current?.skillVersionIds.includes(skill.id)) ?? [],
    files: artifacts.data?.filter((artifact) => current?.artifactIds.includes(artifact.id)) ?? [],
  };
  const myTasks = tasks.data?.filter((task) => task.profileId === profileId) ?? [];
  return (
    <>
      <PageHeader
        title={current?.name ?? 'Agent 详情'}
        badge={current ? <Badge variant="outline">第 {current.revision} 版</Badge> : null}
        actions={
          <>
            <Button variant="ghost" onClick={onBack}>
              <ArrowLeft aria-hidden="true" /> 返回
            </Button>
            {current ? (
              <>
                <Button variant="outline" onClick={() => onAccess(current)}>
                  <KeyRound aria-hidden="true" /> 接入客户端
                </Button>
                <Button onClick={() => onEdit(current)}>
                  <ShieldCheck aria-hidden="true" /> 编辑权限
                </Button>
              </>
            ) : null}
          </>
        }
      />
      <Feedback
        error={
          profile.error ??
          agentTools.error ??
          connections.error ??
          names.error ??
          content.error ??
          artifacts.error ??
          skills.error ??
          tasks.error
        }
      />
      {current ? (
        <div className="space-y-5">
          <Card className="panel padded" aria-labelledby="agent-tools-title">
            <h2 id="agent-tools-title">这个 Agent 能用的工具</h2>
            {agentTools.isPending ? <ListSkeleton /> : null}
            {agentTools.isSuccess && !groups.size ? (
              <Empty
                icon={Wrench}
                title="还没有授权任何工具"
                action={
                  <Button variant="outline" onClick={() => onEdit(current)}>
                    编辑权限
                  </Button>
                }
              />
            ) : null}
            {[...groups].map(([connectionId, rows]) => {
              const entry = names.names.get(connectionId);
              return (
                <section key={connectionId} className="agent-tool-group" aria-label={entry?.name}>
                  <h3>
                    {entry?.name ?? '未知连接'}
                    <small> · {entry?.location ?? '—'}</small>
                  </h3>
                  <table className="agent-tool-table">
                    <thead>
                      <tr>
                        <th scope="col">工具</th>
                        <th scope="col">在客户端中的名称</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((tool) => (
                        <tr key={tool.id}>
                          <td>
                            {tool.name}
                            {tool.unavailable ? (
                              <small className="text-destructive"> · 暂不可用</small>
                            ) : null}
                          </td>
                          <td>
                            <code>{tool.exposedName ?? tool.name}</code>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </section>
              );
            })}
            {granted.content.length || granted.skills.length || granted.files.length ? (
              <dl className="agent-grants">
                {granted.content.length ? (
                  <>
                    <dt>提示词与资源</dt>
                    <dd>{granted.content.map((entry) => entry.name).join('、')}</dd>
                  </>
                ) : null}
                {granted.skills.length ? (
                  <>
                    <dt>Skills</dt>
                    <dd>{granted.skills.map((skill) => skill.name).join('、')}</dd>
                  </>
                ) : null}
                {granted.files.length ? (
                  <>
                    <dt>文件</dt>
                    <dd>{granted.files.map((file) => file.name).join('、')}</dd>
                  </>
                ) : null}
              </dl>
            ) : null}
            <div className="flex flex-wrap gap-4">
              <Link to="/tools" search={{ profileId: current.id }}>
                以此 Agent 测试工具
              </Link>
              <Link to="/activity" search={{ profileId: current.id }}>
                查看此 Agent 的调用记录
              </Link>
            </div>
          </Card>
          <ApprovalPanel profileId={profileId} />
          <Disclosure title="高级：身份、可申请范围、任务与技术详情">
            <div className="space-y-5">
              <Card className="panel padded">
                <h2>身份与运行位置</h2>
                {connections.data?.map((connection) => (
                  <Disclosure
                    key={connection.id}
                    title={`${connection.name} · ${executionLocation(connection, deviceById)}`}
                  >
                    <IdentitySettings
                      key={`${connection.id}:${current.revision}`}
                      profile={current}
                      connection={connection}
                      location={executionLocation(connection, deviceById)}
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
              <Card className="panel padded">
                <h2>任务</h2>
                {myTasks.length ? (
                  myTasks.map((task) => (
                    <p key={task.id}>
                      <a href={`/tasks?task=${task.id}`}>{task.prompt}</a> · {task.status}
                    </p>
                  ))
                ) : (
                  <p className="text-sm text-muted-foreground">还没有任务。</p>
                )}
              </Card>
              <Disclosure title="技术详情（ID 与原始数据）">
                <Code
                  value={{
                    agentId: current.id,
                    工具: agentTools.data?.map((t) => ({
                      name: t.name,
                      exposedName: t.exposedName,
                      id: t.id,
                      connection: t.connectionId,
                    })),
                    内容: current.contentIds,
                    Skills: granted.skills.map((s) => ({ name: s.name, digest: s.digest })),
                    文件: granted.files,
                  }}
                />
              </Disclosure>
            </div>
          </Disclosure>
        </div>
      ) : null}
    </>
  );
}
