import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, json } from '../../lib/api.js';
import { Card } from '../../components/ui/card.js';
import { Textarea } from '../../components/ui/textarea.js';
import { Input } from '../../components/ui/input.js';
import {
  Action,
  Code,
  Empty,
  Feedback,
  Field,
  Form,
  value,
} from '../../components/shared/Controls.js';
type Manifest = {
  name: string;
  revision: number;
  status: 'pending' | 'ready' | 'error';
  declaration: unknown;
  mappings: unknown;
  mode: string;
  entries: { kind: string; name: string; status: 'pending' | 'ready' | 'error'; reason?: string }[];
};
const labels = { pending: '待配置', ready: '已就绪', error: '配置错误' };
const initial = JSON.stringify(
  {
    declaration: { version: 1, name: 'my-platform', connections: {}, profiles: {} },
    mappings: {},
    mode: 'upsert',
  },
  null,
  2,
);
export default function ConfigurationPage() {
  const [text, setText] = useState(initial);
  const [preview, setPreview] = useState<unknown>();
  const [exported, setExported] = useState<unknown>();
  const manifests = useQuery({
    queryKey: ['manifests'],
    queryFn: () => api<Manifest[]>('/config/manifests'),
    refetchInterval: 3000,
  });
  const secrets = useQuery({
    queryKey: ['config-secrets'],
    queryFn: () => api<{ name: string; revision: number }[]>('/config/secrets'),
  });
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">CONFIGURATION</span>
          <h1>配置模板</h1>
          <p>一次保存完整声明，凭证、设备和真实目录就绪后自动解析能力。</p>
        </div>
      </div>
      <Feedback error={manifests.error ?? secrets.error} />
      <div className="overview-grid">
        <Card className="panel padded">
          <h2>预览和应用</h2>
          <Field
            label="JSON 配置声明"
            hint="连接、Profile 使用逻辑名称；秘密使用 secretRef。prune 只清理该声明管理且已移除的对象。"
          >
            <Textarea
              rows={20}
              className="[field-sizing:fixed] max-h-[32rem]"
              spellCheck={false}
              value={text}
              onChange={(event) => {
                setText(event.target.value);
                setPreview(undefined);
              }}
            />
          </Field>
          <div className="row-actions">
            <Action
              action={async () =>
                setPreview(
                  await api('/config/manifests/preview', {
                    method: 'POST',
                    body: json(JSON.parse(text)),
                  }),
                )
              }
            >
              预览变更
            </Action>
            <Action
              action={async () => {
                const result = await api<Manifest>('/config/manifests/apply', {
                  method: 'POST',
                  body: json(JSON.parse(text)),
                });
                setText(
                  JSON.stringify(
                    {
                      declaration: result.declaration,
                      mappings: result.mappings,
                      mode: result.mode,
                      revision: result.revision,
                    },
                    null,
                    2,
                  ),
                );
                setPreview(undefined);
              }}
            >
              保存并应用
            </Action>
            <Action action={async () => setExported(await api('/config/export'))}>
              导出当前配置
            </Action>
          </div>
          {preview ? <Code value={preview} /> : null}
          {exported ? (
            <>
              <p>导出不包含密钥和授权会话；在目标环境补齐 secretRef 及外部映射。</p>
              <Code value={exported} />
            </>
          ) : null}
        </Card>
        <Card className="panel padded">
          <h2>我的配置秘密</h2>
          <p>秘密按当前账号加密保存，不读取宿主机环境变量或文件，也不会随模板导出。</p>
          <Form
            submit={async (data) => {
              await api('/config/secrets', {
                method: 'PUT',
                body: json({ name: value(data, 'name'), value: value(data, 'value') }),
              });
            }}
          >
            <Field label="secretRef 名称">
              <Input name="name" required autoComplete="off" />
            </Field>
            <Field label="秘密值">
              <Input name="value" type="password" required autoComplete="new-password" />
            </Field>
          </Form>
          {secrets.data?.map((secret) => (
            <p key={secret.name}>
              <code>{secret.name}</code> · 版本 {secret.revision}
            </p>
          ))}
        </Card>
      </div>
      <Card className="panel padded">
        <h2>声明状态</h2>
        {!manifests.data?.length ? (
          <Empty>尚未应用配置模板。</Empty>
        ) : (
          manifests.data.map((manifest) => (
            <section key={manifest.name} className="connection-row">
              <h3>
                {manifest.name} · {labels[manifest.status]}
              </h3>
              <small>版本 {manifest.revision}</small>
              <Action
                action={async () => {
                  setText(
                    JSON.stringify(
                      {
                        declaration: manifest.declaration,
                        mappings: manifest.mappings,
                        mode: manifest.mode,
                        revision: manifest.revision,
                      },
                      null,
                      2,
                    ),
                  );
                  setPreview(undefined);
                }}
              >
                载入声明
              </Action>
              {manifest.entries.map((entry) => (
                <div key={`${entry.kind}:${entry.name}`}>
                  <strong>
                    {entry.kind} · {entry.name}
                  </strong>{' '}
                  — {labels[entry.status]}
                  {entry.reason ? <p role="status">{entry.reason}</p> : null}
                </div>
              ))}
            </section>
          ))
        )}
      </Card>
    </>
  );
}
