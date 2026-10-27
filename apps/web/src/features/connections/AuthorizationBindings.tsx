import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, json } from '../../lib/api.js';
import { Action, Code, Feedback, Field, Form, value } from '../../components/shared/Controls.js';
import { Input } from '../../components/ui/input.js';
import { SelectControl } from '../../components/shared/SelectControl.js';
import { SelectItem } from '../../components/ui/select.js';
import { Disclosure } from '../../components/shared/Disclosure.js';
export function AuthorizationBindings({
  connectionId,
  source,
  initialBindingId,
}: {
  connectionId: string;
  source: string;
  initialBindingId?: string;
}) {
  const bindings = useQuery({
    queryKey: ['bindings', connectionId],
    queryFn: () => api<{ id: string; identity: string }[]>(`/connections/${connectionId}/bindings`),
  });
  const [selected, setSelected] = useState(initialBindingId ?? 'default');
  const [scheme, setScheme] = useState('');
  const [impact, setImpact] = useState<unknown>();
  const [result, setResult] = useState<unknown>();
  const root = `/connections/${connectionId}${selected === 'default' ? '' : `/bindings/${selected}`}`;
  const endpoint =
    source === 'openapi' ? `${root}/openapi/oauth/${encodeURIComponent(scheme)}` : `${root}/oauth`;
  return (
    <Disclosure title="上游授权绑定">
      <Feedback error={bindings.error} />
      <Field label="授权归属">
        <SelectControl
          value={selected}
          onValueChange={(v) => {
            if (v) setSelected(v);
          }}
        >
          <SelectItem value="default">当前管理页面身份</SelectItem>
          {bindings.data?.map((b) => (
            <SelectItem key={b.id} value={b.id}>
              {b.identity} · {b.id.slice(0, 12)}
            </SelectItem>
          ))}
        </SelectControl>
      </Field>
      {source === 'openapi' ? (
        <Field label="OpenAPI OAuth 方案名称">
          <Input value={scheme} onChange={(e) => setScheme(e.target.value)} />
        </Field>
      ) : null}
      <div className="row-actions">
        <Action action={async () => setResult(await api(endpoint))}>授权状态</Action>
        <Action action={async () => setResult(await api(`${endpoint}/start`, { method: 'POST' }))}>
          发起授权
        </Action>
        <Action
          action={async () => {
            if (selected === 'default') throw new Error('请选择具体绑定');
            setImpact(await api(`${root}/impact`));
          }}
        >
          查看撤销影响
        </Action>
        <Action
          danger
          action={async () => {
            if (!impact) throw new Error('请先查看此绑定的撤销影响');
            setResult(await api(endpoint, { method: 'DELETE' }));
            setImpact(undefined);
          }}
        >
          撤销此绑定的本地凭证
        </Action>
      </div>
      {source !== 'openapi' ? (
        <Form
          label="完成授权"
          submit={async (data) =>
            setResult(
              await api(`${endpoint}/complete`, {
                method: 'POST',
                body: json({ redirectUrl: value(data, 'redirectUrl') }),
              }),
            )
          }
        >
          <Field label="授权后完整回调 URL">
            <Input name="redirectUrl" type="url" required />
          </Field>
        </Form>
      ) : null}
      {impact ? <Code value={impact} /> : null}
      {result ? <Code value={result} /> : null}
    </Disclosure>
  );
}
