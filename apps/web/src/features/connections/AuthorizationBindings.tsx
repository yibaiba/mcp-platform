import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, json } from '../../lib/api.js';
import { Action, Code, Feedback, Field, Form, value } from '../../components/shared/Controls.js';
import { Input } from '../../components/ui/input.js';
import { SelectControl } from '../../components/shared/SelectControl.js';
import { SelectItem } from '../../components/ui/select.js';
import { Disclosure } from '../../components/shared/Disclosure.js';
import { ConnectionResult } from './ConnectionResult.js';
import { AuthorizationButton } from './AuthorizationButton.js';
export function AuthorizationBindings({
  connectionId,
  source,
  initialBindingId,
  defaultOpen,
}: {
  connectionId: string;
  source: string;
  initialBindingId?: string;
  defaultOpen?: boolean;
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
    <Disclosure title="服务授权绑定" defaultOpen={defaultOpen}>
      <Feedback error={bindings.error} />
      <p className="mb-4 text-xs leading-relaxed text-muted-foreground">
        选择要管理的授权身份。供应商页面确认后自动返回，无需复制回调地址；Agent 专属身份在对应 Agent
        的详情页中配置。
      </p>
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
        <AuthorizationButton endpoint={endpoint} onResult={setResult} />
        <Action action={async () => setResult(await api(endpoint))}>检查授权状态</Action>
      </div>
      <Disclosure title="撤销授权（高级）">
        <p className="text-xs text-muted-foreground">
          先选择具体绑定并查看影响，再撤销该绑定。依赖它的任务和会话会受到影响。
        </p>
        <div className="row-actions">
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
            confirmation={{
              title: '撤销此绑定的本地凭证？',
              description: '依赖该绑定的调用将无法继续。',
              confirmLabel: '撤销',
            }}
            action={async () => {
              if (!impact) throw new Error('请先查看此绑定的撤销影响');
              setResult(await api(endpoint, { method: 'DELETE' }));
              setImpact(undefined);
            }}
          >
            撤销此绑定的本地凭证
          </Action>
        </div>
        {impact ? <Code value={impact} /> : null}
      </Disclosure>
      {source !== 'openapi' ? (
        <Disclosure title="手动完成授权（仅自动回调不可用时）">
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
        </Disclosure>
      ) : null}
      {result ? <ConnectionResult result={result} /> : null}
    </Disclosure>
  );
}
