import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { InteractionPanel } from '../interactions/InteractionPanel.js';
import { Disclosure } from '../../components/shared/Disclosure.js';
import { Code, Field, Form, value } from '../../components/shared/Controls.js';
import { Textarea } from '../../components/ui/textarea.js';
import { Input } from '../../components/ui/input.js';
import { Button } from '../../components/ui/button.js';
import { api, json, type Tool } from '../../lib/api.js';
const AppHost = lazy(() =>
  import('../apps/AppHost.js').then((module) => ({ default: module.AppHost })),
);
export function ToolRunner({
  selected,
  profileId,
  location,
  identity,
}: {
  selected: Tool;
  profileId?: string;
  location: string;
  identity: string;
}) {
  const root = profileId ? `/profiles/${profileId}/agent` : '';
  const [result, setResult] = useState<unknown>();
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const appSession = (result as { _meta?: Record<string, unknown> } | undefined)?._meta?.[
    'platform/appSession'
  ];
  const interactionId = (result as { interactionId?: string } | undefined)?.interactionId;
  return (
    <>
      <h2>{selected.name}</h2>
      <p>
        {location} · {identity}
      </p>
      <small className="break-all">稳定标识：{selected.id}</small>
      <p>
        <Link to="/activity" search={{ profileId, toolId: selected.id }}>
          查看此工具的调用记录
        </Link>
      </p>
      <Disclosure title="参数结构">
        <Code value={selected.definition.inputSchema} />
      </Disclosure>
      <Disclosure title="完整工具定义（输出结构与元数据）">
        <Code value={selected.definition} />
      </Disclosure>
      <Form
        key={selected.id}
        label="执行工具"
        submit={async (data) => {
          controller.current = new AbortController();
          try {
            setResult(
              await api(`${root}/tools/${selected.id}/call`, {
                method: 'POST',
                body: json({
                  arguments: JSON.parse(value(data, 'args')),
                  interactionDeadline: value(data, 'deadline')
                    ? new Date(value(data, 'deadline')).toISOString()
                    : undefined,
                }),
                signal: controller.current.signal,
              }),
            );
          } finally {
            controller.current = null;
          }
        }}
      >
        <Field label="参数（JSON 对象）">
          <Textarea name="args" defaultValue="{}" rows={8} required />
        </Field>
        <Field label="交互等待截止时间（可选）" hint="留空时不额外限制用户补充信息的等待时间。">
          <Input name="deadline" type="datetime-local" />
        </Field>
      </Form>
      <Button variant="outline" onClick={() => controller.current?.abort()}>
        取消请求
      </Button>
      {result !== undefined ? (
        <>
          <h3>返回结果</h3>
          <Code value={result} />
          {interactionId ? <InteractionPanel id={interactionId} onResult={setResult} /> : null}
          {typeof appSession === 'string' ? (
            <Suspense fallback={<p>加载 App…</p>}>
              <AppHost key={appSession} sessionId={appSession} />
            </Suspense>
          ) : null}
        </>
      ) : null}
    </>
  );
}
