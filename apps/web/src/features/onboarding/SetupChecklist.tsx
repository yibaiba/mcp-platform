import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { AlertTriangle, Check, ChevronRight, X } from 'lucide-react';
import { api, type Connection, type IncomingShare, type Profile } from '../../lib/api.js';
import { Button } from '../../components/ui/button.js';
import { Feedback } from '../../components/shared/Controls.js';
import { setupSteps } from './GettingStarted.js';
import { setupStatus, type AccessKey } from './setupProgress.js';

const dismissedKey = 'mcp-platform:setup-dismissed';

/** Three-step onboarding; collapses to one line when done and can then be dismissed. */
export function SetupChecklist() {
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(dismissedKey) === '1';
    } catch {
      return false;
    }
  });
  const connections = useQuery({
    queryKey: ['connections'],
    queryFn: () => api<Connection[]>('/connections'),
  });
  const profiles = useQuery({ queryKey: ['profiles'], queryFn: () => api<Profile[]>('/profiles') });
  const keys = useQuery({
    queryKey: ['keys'],
    queryFn: () => api<AccessKey[]>('/profiles/keys/all'),
  });
  const shares = useQuery({
    queryKey: ['incoming-shares'],
    queryFn: () => api<IncomingShare[]>('/shares'),
  });
  const loaded = connections.isSuccess && profiles.isSuccess && keys.isSuccess && shares.isSuccess;
  const error = connections.error ?? profiles.error ?? keys.error ?? shares.error;
  if (error) return <Feedback error={error} />;
  if (!loaded) return null;
  const status = setupStatus({
    connections: connections.data,
    profiles: profiles.data,
    keys: keys.data,
    shared: shares.data,
  });
  const complete = status.steps;
  const done = complete.filter(Boolean).length;
  const nextIndex = complete.findIndex((value) => !value);
  const next = setupSteps[nextIndex];
  if (status.broken.length) {
    // Configured is not the same as working: fixing a broken connection comes before any next step.
    return (
      <section className="setup setup-degraded" role="status" aria-label="上手流程">
        <AlertTriangle size={16} aria-hidden="true" />
        <span className="grow">
          配置 {done}/{setupSteps.length}，但有 {status.broken.length} 个连接不可用，Agent
          暂时缺少这些工具；其余工具照常可用
        </span>
        <Link to="/connections" className="setup-next">
          去修复 <ChevronRight size={14} aria-hidden="true" />
        </Link>
      </section>
    );
  }
  if (!next) {
    if (dismissed) return null;
    return (
      <section className="setup setup-done" aria-label="上手流程">
        <Check size={16} aria-hidden="true" />
        <span className="grow">平台配置已完成 3/3，请在客户端确认工具列表</span>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="关闭上手清单"
          onClick={() => {
            setDismissed(true);
            try {
              localStorage.setItem(dismissedKey, '1');
            } catch {
              // Private mode: keep it hidden for this session only.
            }
          }}
        >
          <X aria-hidden="true" />
        </Button>
      </section>
    );
  }
  return (
    <section className="setup" aria-label="上手流程">
      <strong>
        上手 {done}/{setupSteps.length}
      </strong>
      <ol className="setup-steps" aria-hidden="true">
        {setupSteps.map((step, index) => (
          <li key={step.title} className={complete[index] ? 'done' : undefined} />
        ))}
      </ol>
      <span className="grow">下一步：{next.title}</span>
      <Link to={next.to} hash={next.hash} className="setup-next">
        {next.action} <ChevronRight size={14} aria-hidden="true" />
      </Link>
    </section>
  );
}
