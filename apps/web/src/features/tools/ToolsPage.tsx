import { SelectControl } from '../../components/shared/SelectControl.js';
import { SelectItem } from '../../components/ui/select.js';
import type { Profile } from '../../lib/api.js';
import { lazy, Suspense } from 'react';
import { InteractionPanel } from '../interactions/InteractionPanel.js';
const AppHost = lazy(() =>
  import('../apps/AppHost.js').then((module) => ({ default: module.AppHost })),
);
import { Disclosure } from '../../components/shared/Disclosure.js';
import { Card } from '../../components/ui/card.js';
import { Textarea } from '../../components/ui/textarea.js';
import { Input } from '../../components/ui/input.js';
import { useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { api, json, type Tool, type Connection } from '../../lib/api.js';
import { Code, Empty, Feedback, Field, Form, value } from '../../components/shared/Controls.js';
import { Button } from '../../components/ui/button.js';
import { ContentCatalog } from './ContentCatalog.js';
export default function ToolsPage() {
  const [profileId, setProfileId] = useState(
    new URLSearchParams(window.location.search).get('profileId') ?? '',
  );
  const profiles = useQuery({ queryKey: ['profiles'], queryFn: () => api<Profile[]>('/profiles') });
  const root = profileId ? `/profiles/${profileId}/agent` : '';
  const tools = useQuery({
    queryKey: ['tools', profileId],
    queryFn: async () =>
      profileId ? (await api<{ tools: Tool[] }>(`${root}/catalog`)).tools : api<Tool[]>('/tools'),
  });
  const connections = useQuery({
    queryKey: ['connections'],
    queryFn: () => api<Connection[]>('/connections'),
  });
  const [filter, setFilter] = useState('');
  const connectionNames = new Map(
    connections.data?.map((connection) => [
      connection.id,
      `${connection.name} · ${connection.deviceId ?? '平台主机'} · ${connection.adapter}`,
    ]),
  );
  const [selected, setSelected] = useState<Tool>();
  const [result, setResult] = useState<unknown>();
  const controller = useRef<AbortController | null>(null);
  const appSession = (result as { _meta?: Record<string, unknown> } | undefined)?._meta?.[
    'platform/appSession'
  ];
  const interactionId = (result as { interactionId?: string } | undefined)?.interactionId;
  const filtered = tools.data?.filter((t) =>
    `${t.name} ${t.definition.description ?? ''}`.toLowerCase().includes(filter.toLowerCase()),
  );
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">TOOL CATALOG</span>
          <h1>工具目录</h1>
          <p>同名工具按连接准确路由。调用测试直接执行真实工具。</p>
        </div>
      </div>
      <Feedback error={tools.error ?? connections.error} />
      <Field label="测试身份上下文">
        <SelectControl
          value={profileId}
          onValueChange={(v) => {
            setProfileId(v ?? '');
            setSelected(undefined);
            setResult(undefined);
          }}
        >
          <SelectItem value="">管理账号（全部管理权限）</SelectItem>
          {profiles.data?.map((p) => (
            <SelectItem key={p.id} value={p.id}>
              {p.name} · 实际 Agent 权限
            </SelectItem>
          ))}
        </SelectControl>
      </Field>
      <label className="search">
        <Search size={18} />
        <Input
          aria-label="搜索工具"
          placeholder="搜索名称或描述…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </label>
      <div className="tool-layout">
        <Card className="panel">
          {filtered?.length ? (
            filtered.map((tool) => (
              <Button
                key={tool.id}
                className={`tool-option ${selected?.id === tool.id ? 'selected' : ''}`}
                onClick={() => {
                  setSelected(tool);
                  setResult(undefined);
                }}
              >
                <strong>{tool.name}</strong>
                <small>{connectionNames.get(tool.connectionId) ?? tool.connectionId}</small>
                <p>{tool.definition.description ?? '未提供描述'}</p>
              </Button>
            ))
          ) : (
            <Empty>没有匹配的工具。请先在 MCP 连接中刷新工具目录。</Empty>
          )}
        </Card>
        <Card className="panel padded">
          {selected ? (
            <>
              <h2>{selected.name}</h2>
              <small className="break-all">稳定标识：{selected.id}</small>
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
                <Field
                  label="交互等待截止时间（可选）"
                  hint="留空时不额外限制用户补充信息的等待时间。"
                >
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
                  {interactionId ? (
                    <InteractionPanel id={interactionId} onResult={setResult} />
                  ) : null}
                  {typeof appSession === 'string' ? (
                    <Suspense fallback={<p>加载 App…</p>}>
                      <AppHost key={appSession} sessionId={appSession} />
                    </Suspense>
                  ) : null}
                </>
              ) : null}
            </>
          ) : (
            <Empty>选择一个工具，查看参数并测试调用。</Empty>
          )}
        </Card>
      </div>
      <ContentCatalog key={profileId} connectionNames={connectionNames} profileId={profileId} />
    </>
  );
}
