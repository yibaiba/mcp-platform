import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, isForbidden } from '../../lib/api.js';
import {
  Action,
  Code,
  Field,
  Feedback,
  Forbidden,
  date,
} from '../../components/shared/Controls.js';
import { Card } from '../../components/ui/card.js';
import { Button } from '../../components/ui/button.js';
import { Input } from '../../components/ui/input.js';
type Log = {
  id: string;
  at: string;
  level: string;
  event: string;
  code?: string;
  method?: string;
  route?: string;
  status?: number;
  durationMs?: number;
};

export default function SystemLogsPage() {
  const [filters, setFilters] = useState({ from: '', before: '', level: '', event: '' });
  const [cursor, setCursor] = useState<string | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [latest, setLatest] = useState<Log | null>(null);
  const [streamError, setStreamError] = useState<Error | null>(null);
  const [preview, setPreview] = useState<{ count: number; token: string } | null>(null);
  const search = new URLSearchParams(
    Object.entries(filters).filter(([, value]) => value),
  ).toString();
  const logs = useQuery({
    queryKey: ['system-logs', search, cursor],
    queryFn: () =>
      api<{ items: Log[]; nextCursor: string | null }>(
        `/admin/logs?${search}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      ),
  });
  useEffect(() => {
    if (!streaming) return;
    setStreamError(null);
    const source = new EventSource('/api/v1/admin/logs/stream');
    source.addEventListener('log', (event) =>
      setLatest(JSON.parse((event as MessageEvent<string>).data) as Log),
    );
    source.addEventListener('error', () => {
      source.close();
      setStreaming(false);
      setStreamError(new Error('日志流已断开或权限已撤销；可手动重新订阅'));
    });
    return () => source.close();
  }, [streaming]);
  if (isForbidden(logs.error)) return <Forbidden />;
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>系统日志</h1>
          <p>仅管理员可见。记录元数据与错误类别；默认永久保留，自动清理由部署配置显式启用。</p>
        </div>
      </div>
      <Feedback error={logs.error ?? streamError} />
      <div className="overview-grid">
        {Object.entries(filters).map(([key, value]) => (
          <Field
            key={key}
            label={
              {
                from: '开始时间（ISO 8601）',
                before: '结束时间（ISO 8601）',
                level: '级别（info / warn / error）',
                event: '事件类型',
              }[key]!
            }
          >
            <Input
              value={value}
              onChange={(e) => {
                setFilters({ ...filters, [key]: e.target.value });
                setCursor(null);
                setPreview(null);
              }}
            />
          </Field>
        ))}
      </div>
      <div className="my-4 flex flex-wrap items-center gap-3">
        <Button variant="outline" onClick={() => setStreaming(!streaming)}>
          {streaming ? '停止实时订阅' : '实时订阅'}
        </Button>
        <Action
          action={async () =>
            setPreview(
              await api('/admin/logs/cleanup/preview', {
                method: 'POST',
                body: JSON.stringify(Object.fromEntries(new URLSearchParams(search))),
              }),
            )
          }
        >
          预览清理范围
        </Action>
        {preview ? (
          <>
            <span>清理 {preview.count} 条日志</span>
            <Action
              danger
              confirmation={{
                title: `清理 ${preview.count} 条日志？`,
                description: '清理后无法恢复。',
                confirmLabel: '清理',
              }}
              action={async () => {
                await api('/admin/logs/cleanup', {
                  method: 'POST',
                  body: JSON.stringify({ token: preview.token }),
                });
                setPreview(null);
                setCursor(null);
              }}
            >
              执行清理
            </Action>
          </>
        ) : null}
      </div>
      {latest ? (
        <Card className="p-5">
          <h2>最近收到的实时事件</h2>
          <Code value={latest} />
        </Card>
      ) : null}
      <Card className="p-5">
        <h2>历史日志 · 每页 50 条</h2>
        {logs.data?.items.map((log) => (
          <div className="border-b py-3" key={log.id}>
            <strong>
              {date(log.at)} · {log.level} · {log.event}
            </strong>
            <p className="break-all">
              {log.method} {log.route} · {log.status} · {log.durationMs} ms {log.code}
            </p>
          </div>
        ))}
      </Card>
      <div className="my-4 flex flex-wrap items-center gap-3">
        <Button variant="outline" disabled={!cursor} onClick={() => setCursor(null)}>
          返回第一页
        </Button>
        <Button
          variant="outline"
          disabled={!logs.data?.nextCursor}
          onClick={() => setCursor(logs.data!.nextCursor)}
        >
          下一页
        </Button>
      </div>
    </>
  );
}
