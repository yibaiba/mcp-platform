import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, json } from '../../lib/api.js';
import { Action, Feedback, Field, Form, value } from '../../components/shared/Controls.js';
import { CheckChoice } from '../../components/shared/CheckChoice.js';
import { SelectControl } from '../../components/shared/SelectControl.js';
import { SelectItem } from '../../components/ui/select.js';
import { Input } from '../../components/ui/input.js';
import { Button } from '../../components/ui/button.js';
type Grant = {
  id: string;
  email: string;
  credentialMode: 'independent' | 'owner';
  version: number;
  toolIds: string[];
  contentIds: string[];
  revoked: boolean;
};
type Catalog = {
  tools: { id: string; name: string }[];
  content: { id: string; name: string; kind: string }[];
};

export function ConnectionShares({ connectionId }: { connectionId: string }) {
  const [editing, setEditing] = useState<Grant>();
  const base = `/connections/${connectionId}/shares`;
  const grants = useQuery({
    queryKey: ['shares', connectionId],
    queryFn: () => api<Grant[]>(base),
  });
  const catalog = useQuery({
    queryKey: ['share-catalog', connectionId],
    queryFn: () => api<Catalog>(`${base}/catalog`),
  });
  return (
    <div className="form">
      <p>
        接收者只能使用选中的工具和内容，并需在自己的 Agent 中再次授权。设备管理、文件同步和 Skill
        安装不会随连接共享。
      </p>
      <Feedback error={grants.error ?? catalog.error} />
      {grants.data?.map((grant) => (
        <div key={grant.id} className="row flex-wrap">
          <span className="grow">
            {grant.email} ·{' '}
            {grant.revoked
              ? '已撤销'
              : grant.credentialMode === 'owner'
                ? '用我的账号凭证'
                : '独立授权'}
          </span>
          <Button variant="outline" onClick={() => setEditing(grant)}>
            {grant.revoked ? '重新授权' : '编辑授权'}
          </Button>
          {!grant.revoked && (
            <Action
              danger
              confirmation={{
                title: '撤销这个共享？',
                description: '接收方将立即无法使用该连接。',
                confirmLabel: '撤销',
              }}
              action={() => api(`${base}/${grant.id}`, { method: 'DELETE' })}
            >
              撤销共享
            </Action>
          )}
        </div>
      ))}
      <Form
        key={`${editing?.id ?? 'new'}:${editing?.version ?? 0}`}
        label={editing ? '更新共享授权' : '创建共享授权'}
        submit={async (data) => {
          await api(base, {
            method: 'PUT',
            body: json({
              recipientEmail: value(data, 'email'),
              credentialMode: value(data, 'credentialMode'),
              toolIds: data.getAll('tools'),
              contentIds: data.getAll('content'),
              version: editing?.version,
            }),
          });
          setEditing(undefined);
        }}
      >
        <Field label="接收账号邮箱">
          <Input
            name="email"
            type="email"
            required
            defaultValue={editing?.email}
            readOnly={Boolean(editing)}
          />
        </Field>
        <Field
          label="凭证使用方式"
          hint="选择“用我的账号凭证”即明确允许接收者以你的上游身份使用所选能力，包括来源设备上的服务。"
        >
          <SelectControl
            name="credentialMode"
            defaultValue={editing?.credentialMode ?? 'independent'}
          >
            <SelectItem value="independent">接收者独立授权（默认）</SelectItem>
            <SelectItem value="owner">允许使用我的凭证或设备服务</SelectItem>
          </SelectControl>
        </Field>
        <fieldset className="form">
          <legend>允许使用的工具</legend>
          {catalog.data?.tools.map((tool) => (
            <CheckChoice
              key={tool.id}
              name="tools"
              value={tool.id}
              defaultChecked={editing?.toolIds.includes(tool.id)}
            >
              {tool.name}
            </CheckChoice>
          ))}
          {catalog.data?.tools.length === 0 && <p>目录中尚无工具，请先连接并完成真实发现。</p>}
        </fieldset>
        <fieldset className="form">
          <legend>允许使用的 Prompt 和 Resource</legend>
          {catalog.data?.content.map((entry) => (
            <CheckChoice
              key={entry.id}
              name="content"
              value={entry.id}
              defaultChecked={editing?.contentIds.includes(entry.id)}
            >
              {entry.kind} · {entry.name}
            </CheckChoice>
          ))}
        </fieldset>
        {editing && (
          <Button variant="outline" type="button" onClick={() => setEditing(undefined)}>
            取消编辑
          </Button>
        )}
      </Form>
    </div>
  );
}
