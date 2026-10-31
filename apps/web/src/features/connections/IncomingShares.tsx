import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, json, type Device, type Connection } from '../../lib/api.js';
import { Disclosure } from '../../components/shared/Disclosure.js';
import { Action, Code, Empty, Feedback, Status } from '../../components/shared/Controls.js';
import { ConnectionForm } from './ConnectionForm.js';
import { AuthorizationBindings } from './AuthorizationBindings.js';
type Share = {
  recovery?: Connection['recovery'];
  id: string;
  connectionId: string;
  name: string;
  credentialMode: 'independent' | 'owner';
  status: string;
  error?: string;
  pendingReason?: string;
  transport?: string;
  source?: string;
};

export function IncomingShares({ devices }: { devices: Device[] }) {
  const shares = useQuery({
    queryKey: ['incoming-shares'],
    queryFn: () => api<Share[]>('/shares'),
    refetchInterval: (query) =>
      query.state.data?.some((share) => share.recovery?.length) ? 5000 : false,
  });
  const [result, setResult] = useState<unknown>();
  return (
    <div className="grid gap-2">
      <Feedback error={shares.error} />
      {shares.data?.length === 0 && <Empty>尚无共享连接。</Empty>}
      {shares.data?.map((share) => (
        <div className="connection-row" key={share.id}>
          <div className="row">
            <strong className="grow">{share.name}</strong>
            {share.status === 'pending' ? (
              <span role="status">待配置</span>
            ) : (
              <Status value={share.status} />
            )}
          </div>
          <p>
            {share.credentialMode === 'owner'
              ? '所有者已允许使用其凭证或设备服务。'
              : '使用你自己的凭证和运行位置。'}{' '}
            仅能使用所有者授权的工具和内容。
          </p>
          {share.pendingReason && <p role="status">{share.pendingReason}</p>}
          {share.error && <p className="error">{share.error}</p>}
          {share.recovery
            ?.filter((state) => state.status !== 'idle')
            .map((state, index) => (
              <p role="status" key={index}>
                自动恢复：
                {state.status === 'blocked'
                  ? '待配置或授权'
                  : state.status === 'recovering'
                    ? '正在尝试'
                    : '等待重试'}{' '}
                · 已尝试 {state.attempts} 次
                {state.nextAt ? ` · 下次 ${new Date(state.nextAt).toLocaleString()}` : ''}
                {state.error ? ` · ${state.error}` : ''}
              </p>
            ))}
          {share.credentialMode === 'independent' && (
            <Disclosure title="配置我的身份和运行位置">
              <ConnectionForm
                devices={devices}
                onSaved={setResult}
                save={(config) =>
                  api(`/shares/${share.id}/configuration`, { method: 'PUT', body: json(config) })
                }
              />
            </Disclosure>
          )}
          {share.status !== 'pending' && (
            <div className="row-actions">
              <Action
                action={async () =>
                  setResult(
                    await api(`/connections/${share.connectionId}/discover`, { method: 'POST' }),
                  )
                }
              >
                连接 / 刷新工具列表
              </Action>
              {share.credentialMode === 'independent' &&
                share.transport !== 'stdio' &&
                share.source !== 'openapi' && (
                  <Action
                    action={async () =>
                      setResult(
                        await api(`/connections/${share.connectionId}/oauth/start`, {
                          method: 'POST',
                        }),
                      )
                    }
                  >
                    发起我的授权
                  </Action>
                )}
            </div>
          )}
          {share.credentialMode === 'independent' &&
            share.status !== 'pending' &&
            share.transport !== 'stdio' && (
              <AuthorizationBindings
                connectionId={share.connectionId}
                source={share.source ?? 'mcp'}
              />
            )}
        </div>
      ))}
      {result !== undefined && <Code value={result} />}
    </div>
  );
}
