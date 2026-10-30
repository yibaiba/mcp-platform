import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { InteractionPanel } from '../interactions/InteractionPanel.js';
import { Disclosure } from '../../components/shared/Disclosure.js';
import { Code, Field, Form, value } from '../../components/shared/Controls.js';
import { Textarea } from '../../components/ui/textarea.js';
import { Input } from '../../components/ui/input.js';
import { Button } from '../../components/ui/button.js';
import { Hint } from '../../components/ui/tooltip.js';
import { Check, Copy, History } from 'lucide-react';
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
  const [running, setRunning] = useState(false);
  const [copied, setCopied] = useState(false);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const appSession = (result as { _meta?: Record<string, unknown> } | undefined)?._meta?.[
    'platform/appSession'
  ];
  const interactionId = (result as { interactionId?: string } | undefined)?.interactionId;
  return (
    <>
      <div className="runner-title">
        <h2 className="truncate">{selected.name}</h2>
        <Hint content={copied ? '已复制' : `复制标识 ${selected.id}`}>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="复制工具标识"
            onClick={() =>
              void navigator.clipboard
                .writeText(selected.id)
                .then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                })
                .catch(() => setCopied(false))
            }
          >
            {copied ? (
              <Check aria-hidden="true" className="copy-done" />
            ) : (
              <Copy aria-hidden="true" />
            )}
          </Button>
        </Hint>
        <Hint content="调用记录">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="查看此工具的调用记录"
            render={<Link to="/activity" search={{ profileId, toolId: selected.id }} />}
          >
            <History aria-hidden="true" />
          </Button>
        </Hint>
      </div>
      <p className="runner-meta">
        {location} · {identity}
      </p>
      {selected.definition.description ? <p>{selected.definition.description}</p> : null}
      <Disclosure title="定义">
        <h3>参数结构</h3>
        <Code value={selected.definition.inputSchema} />
        <h3>完整定义</h3>
        <Code value={selected.definition} />
      </Disclosure>
      <Form
        key={selected.id}
        label="执行工具"
        submit={async (data) => {
          controller.current = new AbortController();
          setRunning(true);
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
            setRunning(false);
          }
        }}
      >
        <Field label="参数（JSON 对象）">
          <Textarea name="args" defaultValue="{}" rows={8} required />
        </Field>
        <Disclosure title="高级">
          <Field label="交互等待截止时间" hint="留空不限制等待用户补充信息的时间。">
            <Input name="deadline" type="datetime-local" />
          </Field>
        </Disclosure>
      </Form>
      {running ? (
        <Button variant="outline" onClick={() => controller.current?.abort()}>
          取消请求
        </Button>
      ) : null}
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
