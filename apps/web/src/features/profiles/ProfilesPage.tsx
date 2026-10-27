import { WorkspacePage } from './WorkspacePage.js';
import { Card } from '../../components/ui/card.js';
import { CheckChoice } from '../../components/shared/CheckChoice.js';
import { Button } from '../../components/ui/button.js';
import { Textarea } from '../../components/ui/textarea.js';
import { Input } from '../../components/ui/input.js';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  api,
  json,
  type Tool,
  type Profile,
  type Skill,
  type Connection,
  type ContentEntry,
} from '../../lib/api.js';
import { ContentGrants, appInfo } from './ContentGrants.js';
import { ClientExport } from './ClientExport.js';
import {
  Action,
  Code,
  Empty,
  Feedback,
  Field,
  Form,
  value,
} from '../../components/shared/Controls.js';
export default function ProfilesPage() {
  const profiles = useQuery({ queryKey: ['profiles'], queryFn: () => api<Profile[]>('/profiles') });
  const tools = useQuery({ queryKey: ['tools'], queryFn: () => api<Tool[]>('/tools') });
  const catalog = useQuery({
    queryKey: ['catalog'],
    queryFn: () => api<ContentEntry[]>('/catalog'),
  });
  const connections = useQuery({
    queryKey: ['connections'],
    queryFn: () => api<Connection[]>('/connections'),
  });
  const skills = useQuery({ queryKey: ['skills'], queryFn: () => api<Skill[]>('/skills') });
  const artifacts = useQuery({
    queryKey: ['artifacts'],
    queryFn: () => api<{ id: string; name: string }[]>('/artifacts'),
  });
  const keys = useQuery({
    queryKey: ['keys'],
    queryFn: () => api<{ id: string; profileId: string; revoked: boolean }[]>('/profiles/keys/all'),
  });
  const [workspace, setWorkspace] = useState<string | null>(
    new URLSearchParams(window.location.search).get('workspace'),
  );
  const [editing, setEditing] = useState<Profile>();
  const [key, setKey] = useState<unknown>();
  const connectionNames = new Map(
    connections.data?.map((connection) => [connection.id, connection.name]),
  );
  if (workspace)
    return (
      <WorkspacePage
        profileId={workspace}
        onBack={() => {
          setWorkspace(null);
          window.history.replaceState(null, '', '/profiles');
        }}
      />
    );
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">AGENT PROFILES</span>
          <h1>Agent 配置</h1>
          <p>工具、提示词和资源分别授权。内部 Pi 与外部 Agent 共用权限。</p>
        </div>
      </div>
      <Feedback
        error={
          profiles.error ??
          tools.error ??
          skills.error ??
          keys.error ??
          connections.error ??
          artifacts.error ??
          catalog.error
        }
      />
      <div className="overview-grid">
        <Card className="panel padded">
          <h2>{editing ? `编辑：${editing.name}` : '创建配置'}</h2>
          <Form
            key={editing?.id ?? 'new'}
            submit={async (data) => {
              await api(editing ? `/profiles/${editing.id}` : '/profiles', {
                method: editing ? 'PUT' : 'POST',
                body: json({
                  revision: editing?.revision,
                  name: value(data, 'name'),
                  instructions: value(data, 'instructions'),
                  toolIds: data.getAll('toolId'),
                  contentIds: data.getAll('contentId'),
                  skillVersionIds: data.getAll('skillVersionId'),
                  artifactIds: data.getAll('artifactId'),
                }),
              });
              setEditing(undefined);
            }}
          >
            <Field label="配置名称">
              <Input
                name="name"
                required
                defaultValue={editing?.name}
                placeholder="例如：Claude Code"
              />
            </Field>
            <Field label="Agent 说明" hint="按授权服务的稳定顺序追加上游服务说明，并标记来源。">
              <Textarea name="instructions" defaultValue={editing?.instructions ?? ''} />
            </Field>
            <fieldset>
              <legend>允许访问的工具</legend>
              {tools.data?.map((tool) => (
                <CheckChoice
                  key={tool.id}
                  name="toolId"
                  value={tool.id}
                  defaultChecked={editing?.toolIds.includes(tool.id)}
                >
                  <span>
                    <strong>{tool.name}</strong>
                    <small>{connectionNames.get(tool.connectionId)}</small>
                    {appInfo(tool) ? (
                      <small>
                        {appInfo(tool)?.resourceUri
                          ? `App UI：${appInfo(tool)?.resourceUri} · `
                          : ''}
                        {appInfo(tool)?.visibility?.includes('app') &&
                        !appInfo(tool)?.visibility?.includes('model')
                          ? '仅 App 可用，不提供给模型'
                          : '可供模型调用'}
                      </small>
                    ) : null}
                  </span>
                </CheckChoice>
              ))}
              {!tools.data?.length ? <small>先连接 MCP 并发现工具。</small> : null}
            </fieldset>
            <ContentGrants
              entries={catalog.data ?? []}
              selected={editing?.contentIds ?? []}
              connectionNames={connectionNames}
              tools={tools.data ?? []}
            />
            <fieldset>
              <legend>Skill 版本</legend>
              {skills.data?.map((skill) => (
                <CheckChoice
                  key={skill.id}
                  name="skillVersionId"
                  value={skill.id}
                  defaultChecked={editing?.skillVersionIds.includes(skill.id)}
                >
                  <span>
                    {skill.name} <code>{skill.digest.slice(0, 10)}</code>
                  </span>
                </CheckChoice>
              ))}
            </fieldset>
            <fieldset>
              <legend>允许下载的产物</legend>
              {artifacts.data?.map((artifact) => (
                <CheckChoice
                  key={artifact.id}
                  name="artifactId"
                  value={artifact.id}
                  defaultChecked={editing?.artifactIds?.includes(artifact.id)}
                >
                  <span>{artifact.name}</span>
                </CheckChoice>
              ))}
            </fieldset>
          </Form>
        </Card>
        <Card className="panel">
          <div className="panel-heading">
            <h2>已创建配置</h2>
          </div>
          {profiles.data?.length ? (
            profiles.data.map((profile) => (
              <div className="connection-row" key={profile.id}>
                <h3>{profile.name}</h3>
                <small>
                  {profile.toolIds.length} 个工具 · {profile.skillVersionIds.length} 个 Skills
                </small>
                <Code value={`${window.location.origin}/mcp/${profile.id}`} />
                <div className="row-actions">
                  <Button
                    onClick={() => {
                      setWorkspace(profile.id);
                      window.history.replaceState(null, '', `/profiles?workspace=${profile.id}`);
                    }}
                  >
                    打开工作空间
                  </Button>
                  <Button onClick={() => setEditing(profile)}>编辑权限</Button>
                  <ClientExport profileId={profile.id} />
                  <Action
                    action={async () =>
                      setKey(await api(`/profiles/${profile.id}/keys`, { method: 'POST' }))
                    }
                  >
                    生成接入密钥
                  </Action>
                </div>
                {keys.data
                  ?.filter((k) => k.profileId === profile.id && !k.revoked)
                  .map((k) => (
                    <div className="row" key={k.id}>
                      <code className="grow">{k.id.slice(0, 8)}…</code>
                      <Action
                        danger
                        action={() => api(`/profiles/keys/${k.id}`, { method: 'DELETE' })}
                      >
                        撤销密钥
                      </Action>
                    </div>
                  ))}
              </div>
            ))
          ) : (
            <Empty>创建配置后，可生成外部 Agent 接入设置。</Empty>
          )}
        </Card>
      </div>
      {key ? (
        <Card className="panel padded">
          <h2>接入配置</h2>
          <p>密钥仅在此时展示。复制到 Agent 的 MCP 配置中。</p>
          <Code value={key} />
          <ClientExport
            issued={(key as { exports: Parameters<typeof ClientExport>[0]['issued'] }).exports}
          />
          <Button onClick={() => setKey(undefined)}>关闭密钥展示</Button>
        </Card>
      ) : null}
    </>
  );
}
