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
import { ContentGrants } from './ContentGrants.js';
import { ToolGrants } from './ToolGrants.js';
import { useConnectionNames } from '../connections/useConnectionNames.js';

export function ProfilePermissionsEditor({
  editing,
  onSaved,
  connectionId,
}: {
  editing?: Profile;
  onSaved: (profile: Profile) => void;
  connectionId?: string;
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
    { name: '工具列表', query: tools },
    { name: '提示词与资源列表', query: catalog },
    { name: '连接列表', query: connections },
    { name: 'Skill 列表', query: skills },
    { name: '文件列表', query: artifacts },
  ];
  const shared = useConnectionNames().names;
  const ready = sources.every(({ query }) => query.isSuccess && !query.isFetching);
  const loaded = sources.every(({ query }) => query.data !== undefined);
  // Own and shared connections, so a shared connection is named rather than shown as an id.
  const connectionNames = new Map([
    ...[...shared].map(([id, entry]) => [id, entry.name] as const),
    ...(connections.data?.map((connection) => [connection.id, connection.name] as const) ?? []),
  ]);
  // Coming from a connection (own or shared), its tools start checked: on a new Agent, and
  // added to an existing Agent's selection.
  const fromConnection = connectionId
    ? (tools.data ?? [])
        .filter((tool) => tool.connectionId === connectionId && !tool.unavailable)
        .map((tool) => tool.id)
    : [];
  const preselected = [...new Set([...(editing?.toolIds ?? []), ...fromConnection])];
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
          可授权的内容尚未完整加载，暂时无法编辑或保存。请等待加载完成，或重试失败项。
        </p>
      ) : null}
      {!loaded && sources.some(({ query }) => query.isPending) ? <ListSkeleton rows={3} /> : null}
      {loaded ? (
        <Form
          key={editing?.id ?? 'new'}
          disabled={!ready}
          label={editing ? '保存' : '创建'}
          submit={async (data) => {
            const saved = await api<Profile>(editing ? `/profiles/${editing.id}` : '/profiles', {
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
            onSaved(saved);
          }}
        >
          <Field label="Agent 名称">
            <Input
              name="name"
              required
              defaultValue={
                editing?.name ??
                (connectionId && connectionNames.has(connectionId)
                  ? `${connectionNames.get(connectionId)} Agent`
                  : '')
              }
              placeholder="例如：Claude Code"
            />
          </Field>
          <Field label="Agent 说明" hint="会按固定顺序附上各连接自带的说明，并标明来源。">
            <Textarea name="instructions" defaultValue={editing?.instructions ?? ''} />
          </Field>
          <ToolGrants
            tools={tools.data ?? []}
            selected={preselected}
            connectionNames={connectionNames}
            connectionId={connectionId}
            creating={!editing}
          />
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
            <legend>允许下载的文件</legend>
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
            {!artifacts.data?.length ? <small>还没有文件。</small> : null}
          </fieldset>
        </Form>
      ) : null}
    </>
  );
}
