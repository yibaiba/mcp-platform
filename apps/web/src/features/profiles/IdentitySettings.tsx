import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, json, profileUpdate, type Connection, type Profile } from '../../lib/api.js';
import { Action, Code, Feedback, Field, Form, value } from '../../components/shared/Controls.js';
import { SelectControl } from '../../components/shared/SelectControl.js';
import { SelectItem } from '../../components/ui/select.js';
import { Textarea } from '../../components/ui/textarea.js';
import { Input } from '../../components/ui/input.js';
import { AuthorizationBindings } from '../connections/AuthorizationBindings.js';
export function IdentitySettings({
  profile,
  connection,
  location,
}: {
  profile: Profile;
  connection: Connection;
  /** Readable place it runs (device name or 平台服务器). */
  location: string;
}) {
  const [impact, setImpact] = useState<unknown>();
  const [result, setResult] = useState<unknown>();
  const context = useQuery({
    queryKey: ['identity', profile.id, connection.id, profile.revision],
    queryFn: () =>
      api<{
        bindingId: string;
        bindingRevision: number;
        identity: string;
        deviceId?: string;
        credentialEnv: string[];
        credentialHeaders: string[];
      }>(`/profiles/${profile.id}/agent/connections/${connection.id}`),
  });
  const [credentialForm, setCredentialForm] = useState(0);
  const root = `/profiles/${profile.id}/agent/connections/${connection.id}`;
  return (
    <section className="connection-row">
      <h3>{connection.name}</h3>
      <p>运行位置：{location}</p>
      <Feedback error={context.error} />
      <Form
        label="保存身份选择"
        submit={async (data) => {
          if (!impact) throw new Error('请先查看受影响的任务与调用。');
          await api(`/profiles/${profile.id}`, {
            method: 'PUT',
            body: json(
              profileUpdate(profile, {
                connectionIdentities: {
                  ...profile.connectionIdentities,
                  [connection.id]: value(data, 'mode'),
                },
              }),
            ),
          });
          setImpact(undefined);
        }}
      >
        <Field label="上游身份方式" hint="专属身份跨入口保持一致；运行会话仍按入口和任务隔离。">
          <SelectControl
            name="mode"
            defaultValue={profile.connectionIdentities[connection.id] ?? 'inherit'}
          >
            <SelectItem value="inherit">沿用连接身份</SelectItem>
            <SelectItem value="profile">Agent 专属身份</SelectItem>
            <SelectItem value="credential">按调用凭证隔离</SelectItem>
          </SelectControl>
        </Field>
        <Action action={async () => setImpact(await api(`/profiles/${profile.id}/impact`))}>
          查看切换影响
        </Action>
        {impact ? <Code value={impact} /> : null}
      </Form>
      <p>
        当前测试身份：{context.data?.identity ?? '尚未解析'} · 绑定 {context.data?.bindingId ?? '—'}
      </p>
      <div className="row-actions">
        <Action action={async () => setResult(await api(`${root}/discover`, { method: 'POST' }))}>
          以此 Agent 发现
        </Action>
        <Action action={async () => setResult(await api(`${root}/check`, { method: 'POST' }))}>
          以此 Agent 检查
        </Action>
      </div>
      <Form
        key={credentialForm}
        label="加密保存此绑定凭证"
        submit={async (data) => {
          if (!context.data) throw new Error('请先解析绑定');
          await api(
            `/connections/${connection.id}/bindings/${context.data.bindingId}/credentials`,
            {
              method: 'PUT',
              body: json({
                ...JSON.parse(value(data, 'credentials')),
                revision: context.data.bindingRevision,
              }),
            },
          );
          setCredentialForm((v) => v + 1);
        }}
      >
        <Field
          label="独立凭证（JSON）"
          hint={`仅保存在服务端加密绑定。声明的环境变量：${context.data?.credentialEnv.join('、') || '无'}；HTTP 字段：${context.data?.credentialHeaders.join('、') || '无'}。OpenAPI 使用 openapi 对象按方案名称填写。`}
        >
          <Textarea
            name="credentials"
            rows={3}
            defaultValue={'{"headers":{},"env":{}}'}
            autoComplete="off"
            spellCheck={false}
          />
        </Field>
      </Form>
      <Form
        label="声明连接的身份字段"
        submit={(data) =>
          api(`/connections/${connection.id}`, {
            method: 'PATCH',
            body: json({
              revision: connection.revision,
              credentialEnv: value(data, 'env')
                .split(',')
                .map((v) => v.trim())
                .filter(Boolean),
              credentialHeaders: value(data, 'headers')
                .split(',')
                .map((v) => v.trim())
                .filter(Boolean),
            }),
          })
        }
      >
        <Field label="凭证环境变量名（逗号分隔）">
          <Input name="env" defaultValue={context.data?.credentialEnv.join(',')} />
        </Field>
        <Field label="凭证 HTTP 请求头名（逗号分隔）">
          <Input name="headers" defaultValue={context.data?.credentialHeaders.join(',')} />
        </Field>
      </Form>
      <AuthorizationBindings
        key={context.data?.bindingId ?? 'loading'}
        connectionId={connection.id}
        source={connection.source ?? 'mcp'}
        initialBindingId={context.data?.bindingId}
      />
      {result ? <Code value={result} /> : null}
    </section>
  );
}
