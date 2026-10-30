import { useQuery } from '@tanstack/react-query';
import { CheckChoice } from '../../components/shared/CheckChoice.js';
import { ErrorState, Field, Form, ListSkeleton, value } from '../../components/shared/Controls.js';
import { Input } from '../../components/ui/input.js';
import { Textarea } from '../../components/ui/textarea.js';
import {
  api,
  json,
  type Profile,
  type Tool,
  type Skill,
  type ContentEntry,
  type Connection,
} from '../../lib/api.js';
import { ContentGrants, appInfo } from './ContentGrants.js';

export function ProfilePermissionsEditor({
  editing,
  onSaved,
}: {
  editing?: Profile;
  onSaved: () => void;
}) {
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
  const sources = [
    { name: '工具目录', query: tools },
    { name: '内容目录', query: catalog },
    { name: '连接目录', query: connections },
    { name: 'Skill 目录', query: skills },
    { name: '产物目录', query: artifacts },
  ];
  const ready = sources.every(({ query }) => query.isSuccess && !query.isFetching);
  const loaded = sources.every(({ query }) => query.data !== undefined);
  const connectionNames = new Map(
    connections.data?.map((connection) => [connection.id, connection.name]),
  );
  return (
    <>
      {sources.map(({ name, query }) => (
        <ErrorState
          key={name}
          title={`${name}加载失败`}
          error={query.error}
          onRetry={() => query.refetch()}
        />
      ))}
      {!ready ? (
        <p role="status">
          授权目录尚未完整加载，暂时无法编辑或保存。请等待加载完成，或重试失败项。
        </p>
      ) : null}
      {!loaded && sources.some(({ query }) => query.isPending) ? <ListSkeleton rows={3} /> : null}
      {loaded ? (
        <Form
          key={editing?.id ?? 'new'}
          disabled={!ready}
          label={editing ? '保存' : '创建'}
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
            onSaved();
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
                      {appInfo(tool)?.resourceUri ? `App UI：${appInfo(tool)?.resourceUri} · ` : ''}
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
            {!skills.data?.length ? <small>还没有 Skill。</small> : null}
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
            {!artifacts.data?.length ? <small>还没有产物。</small> : null}
          </fieldset>
        </Form>
      ) : null}
    </>
  );
}
