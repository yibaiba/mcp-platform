import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ArrowRight, Check } from 'lucide-react';
import { api, type Connection, type Profile } from '../../lib/api.js';
import { Card } from '../../components/ui/card.js';
import { Feedback } from '../../components/shared/Controls.js';
import { GettingStarted, setupSteps } from './GettingStarted.js';
import { setupProgress, type AccessKey } from './setupProgress.js';

export function SetupChecklist({ compact = false }: { compact?: boolean }) {
  const connections = useQuery({
    queryKey: ['connections'],
    queryFn: () => api<Connection[]>('/connections'),
  });
  const profiles = useQuery({ queryKey: ['profiles'], queryFn: () => api<Profile[]>('/profiles') });
  const keys = useQuery({
    queryKey: ['keys'],
    queryFn: () => api<AccessKey[]>('/profiles/keys/all'),
  });
  const loaded = connections.isSuccess && profiles.isSuccess && keys.isSuccess;
  const error = connections.error ?? profiles.error ?? keys.error;
  const complete = loaded
    ? setupProgress({ connections: connections.data, profiles: profiles.data, keys: keys.data })
    : [];
  const nextIndex = complete.findIndex((done) => !done);
  const next = setupSteps[nextIndex];
  return (
    <Card className={compact ? 'mb-5 gap-3 p-4' : 'gap-0 p-5'} aria-label="上手流程">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm">
            {loaded
              ? next
                ? `下一步：${next.title}`
                : '配置已就绪，去客户端检查工具目录'
              : error
                ? '上手进度读取失败'
                : '正在读取上手进度…'}
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {loaded && !next
              ? '接入密钥已生成；是否接通客户端，请在客户端确认。'
              : '连接服务 → 分配 Agent 权限 → 复制客户端配置'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {loaded && next ? (
            <Link
              to={next.to}
              hash={next.hash}
              className="inline-flex min-h-10 items-center gap-1 text-xs text-primary hover:underline"
            >
              {next.action}
              <ArrowRight size={14} aria-hidden="true" />
            </Link>
          ) : null}
          <GettingStarted />
        </div>
      </div>
      <Feedback error={error} />
      {!compact && loaded ? (
        <ol className="mt-4 divide-y">
          {setupSteps.map((step, index) => (
            <li key={step.title}>
              <Link to={step.to} hash={step.hash} className="flex min-h-16 items-center gap-3 py-3">
                <span
                  className={`flex size-7 shrink-0 items-center justify-center rounded-full border ${complete[index] ? 'border-primary/30 bg-primary/10 text-primary' : 'text-muted-foreground'}`}
                  aria-hidden="true"
                >
                  {complete[index] ? <Check size={14} /> : index + 1}
                </span>
                <span className="grow">
                  <strong className="block text-xs">{step.title}</strong>
                  <span className="text-xs text-muted-foreground">
                    {complete[index] ? step.ready : step.action}
                  </span>
                </span>
                <ArrowRight size={14} className="text-muted-foreground" aria-hidden="true" />
              </Link>
            </li>
          ))}
        </ol>
      ) : null}
    </Card>
  );
}
