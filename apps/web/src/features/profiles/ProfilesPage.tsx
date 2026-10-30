import { PageHeader } from '../../components/shared/PageHeader.js';
import { DiscoveryEditor } from './DiscoveryEditor.js';
import { CatalogEditor } from './CatalogEditor.js';
import { WorkspacePage } from './WorkspacePage.js';
import { Card } from '../../components/ui/card.js';
import { CheckChoice } from '../../components/shared/CheckChoice.js';
import { Button } from '../../components/ui/button.js';
import { Textarea } from '../../components/ui/textarea.js';
import { Input } from '../../components/ui/input.js';
import { useState } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog.js';
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
  const { workspace } = useSearch({ from: '/profiles' });
  const navigate = useNavigate({ from: '/profiles' });
  const [discoveryEditing, setDiscoveryEditing] = useState<Profile>();
  const [catalogEditing, setCatalogEditing] = useState<Profile>();
  const [editing, setEditing] = useState<Profile>();
  const [key, setKey] = useState<unknown>();
  const connectionNames = new Map(
    connections.data?.map((connection) => [connection.id, connection.name]),
  );
  if (workspace)
    return <WorkspacePage profileId={workspace} onBack={() => void navigate({ search: {} })} />;
  return (
    <>
      <PageHeader title="Agent" />
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
      <div className="mb-5 rounded-lg border bg-muted/20 p-4 text-xs leading-relaxed text-muted-foreground">
        <strong className="text-foreground">在这里把工具交给 Agent：</strong>{' '}
        填写名称、勾选工具并保存，然后在“已创建配置”中生成接入密钥。首次生成后，点击“复制完整客户端配置”即可带上密钥，无需手动拼接。
      </div>
      {discoveryEditing ? (
        <DiscoveryEditor
          key={discoveryEditing.id}
          profile={discoveryEditing}
          tools={tools.data ?? []}
          close={() => setDiscoveryEditing(undefined)}
        />
      ) : null}
      {catalogEditing ? (
        <CatalogEditor
          key={catalogEditing.id}
          profile={catalogEditing}
          tools={tools.data ?? []}
          entries={catalog.data ?? []}
          connections={connections.data ?? []}
          close={() => setCatalogEditing(undefined)}
        />
      ) : null}
      <div className="overview-grid">
        <Card id="create-profile" className="panel padded scroll-mt-6">
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
        <Card id="agent-configurations" className="panel scroll-mt-6">
          <div className="panel-heading">
            <h2>已创建配置</h2>
          </div>
          {profiles.data?.length ? (
            profiles.data.map((profile) => (
              <div className="connection-row" key={profile.id}>
                <h3>{profile.name}</h3>
                {profile.deploymentState !== 'ready' ? (
                  <p>配置模板尚未就绪；请到配置模板页面检查待配置条目。</p>
                ) : null}
                <small>
                  {profile.toolIds.length} 个工具 · {profile.skillVersionIds.length} 个 Skills
                </small>
                <Code value={`${window.location.origin}/mcp/${profile.id}`} />
                <div className="row-actions">
                  <Button
                    onClick={() => {
                      void navigate({ search: { workspace: profile.id } });
                    }}
                  >
                    打开工作空间
                  </Button>
                  <Button
                    onClick={() => {
                      setEditing(profile);
                      window.location.hash = 'create-profile';
                    }}
                  >
                    编辑权限
                  </Button>
                  <Button onClick={() => setCatalogEditing(profile)}>目录展示</Button>
                  <Button onClick={() => setDiscoveryEditing(profile)}>智能发现</Button>
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
                        confirmation={{
                          title: `撤销密钥 ${k.id.slice(0, 8)}…？`,
                          description: '使用它的客户端会立即失效。',
                          confirmLabel: '撤销',
                        }}
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
      <Dialog
        open={Boolean(key)}
        onOpenChange={(open) => {
          if (!open) setKey(undefined);
        }}
      >
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>接入配置已生成</DialogTitle>
            <DialogDescription>
              密钥仅在此时展示。先复制完整客户端配置，再关闭此窗口。
            </DialogDescription>
          </DialogHeader>
          {key ? (
            <>
              <ClientExport
                issued={(key as { exports: Parameters<typeof ClientExport>[0]['issued'] }).exports}
              />
              <Code value={key} />
              <Button onClick={() => setKey(undefined)}>关闭密钥展示</Button>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
