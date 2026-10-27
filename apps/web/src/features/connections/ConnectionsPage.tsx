import { ConnectionSettings } from './ConnectionSettings.js';
import { OpenApiPanel } from './OpenApiPanel.js';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { ConnectorPreset, ConnectorAuthentication } from '@platform/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { Plug, Plus } from 'lucide-react';
import { Card } from '../../components/ui/card.js';
import { Button } from '../../components/ui/button.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '../../components/ui/dialog.js';
import { api, type Connection, type Device } from '../../lib/api.js';
import { Action, Empty, Feedback, Status } from '../../components/shared/Controls.js';
import { ConnectionForm } from './ConnectionForm.js';
import { ImportPanel } from './ImportPanel.js';
import { AuthorizationBindings } from './AuthorizationBindings.js';
import { ConnectorCatalog } from './ConnectorCatalog.js';
import { ConnectorForm } from './ConnectorForm.js';
import { ConnectionResult } from './ConnectionResult.js';
import { AuthorizationButton } from './AuthorizationButton.js';
import { authorizeConnection } from './authorizationFlow.js';
import { authorizationResult } from './authorizationResult.js';

export default function ConnectionsPage() {
  const [editing, setEditing] = useState<Connection>();
  const [show, setShow] = useState(false);
  const [preset, setPreset] = useState<ConnectorPreset>();
  const [result, setResult] = useState<unknown>();
  const [setupError, setSetupError] = useState<Error | null>(null);
  const [setupMessage, setSetupMessage] = useState('');
  const queryClient = useQueryClient();
  async function connectCreated(created: { id: string }, authentication: ConnectorAuthentication) {
    setShow(false);
    setSetupError(null);
    setSetupMessage(
      authentication === 'oauth' ? '配置已保存，正在准备授权…' : '配置已保存，正在发现工具…',
    );
    try {
      if (authentication === 'oauth' && preset?.oauthRegistration) {
        setResult(await api(`/connections/${created.id}/oauth`));
        setSetupMessage(
          '配置已保存。GitHub 首次接入需将高级授权诊断中的回调地址登记到应用，再点击此连接的“发起授权”；之后自动返回并更新目录。',
        );
        return;
      }
      const connected =
        authentication === 'oauth'
          ? await authorizeConnection({
              endpoint: `/connections/${created.id}/oauth`,
              request: api,
              navigate: (url) => window.location.assign(url),
            })
          : await api(`/connections/${created.id}/discover`, { method: 'POST' });
      setResult(connected);
      setSetupMessage(
        authentication === 'oauth'
          ? authorizationResult(connected).url
            ? '正在前往供应商授权页，确认权限后会自动返回。'
            : '授权已完成，工具目录已更新。'
          : '连接成功，工具目录已更新。',
      );
    } catch (error) {
      setSetupMessage('配置已保存，连接未完成。可在下方此连接中重新发起授权或刷新目录。');
      setSetupError(error instanceof Error ? error : new Error(String(error)));
    } finally {
      await queryClient.invalidateQueries();
    }
  }
  const connections = useQuery({
    queryKey: ['connections'],
    queryFn: () => api<Connection[]>('/connections'),
  });
  const devices = useQuery({ queryKey: ['devices'], queryFn: () => api<Device[]>('/devices') });
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">CONNECTIONS</span>
          <h1>MCP 连接</h1>
          <p>连接、授权和调用 MCP 工具无需配置模型；选择执行位置、连接方式和凭证归属。</p>
        </div>
        <Dialog open={show} onOpenChange={setShow}>
          <DialogTrigger render={<Button onClick={() => setPreset(undefined)} />}>
            <Plus size={17} />
            添加连接
          </DialogTrigger>
          <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
            <DialogHeader>
              <DialogTitle>{preset ? `添加 ${preset.name}` : '新建 MCP 连接'}</DialogTitle>
              <DialogDescription>
                {preset
                  ? '使用官方远程 MCP 服务。保存配置后完成认证，连接成功后再配置 Agent 权限。'
                  : '选择执行位置和连接协议，再填写服务地址或启动命令。'}
              </DialogDescription>
            </DialogHeader>
            {preset ? (
              <ConnectorForm key={preset.id} preset={preset} onSaved={connectCreated} />
            ) : (
              <ConnectionForm
                devices={devices.data ?? []}
                onSaved={(created) => {
                  setResult(created);
                  setShow(false);
                }}
              />
            )}
          </DialogContent>
        </Dialog>
      </div>
      <Feedback error={connections.error ?? devices.error} />
      {setupMessage ? <p role="status">{setupMessage}</p> : null}
      <Feedback error={setupError} />
      <ConnectorCatalog
        connections={connections.data ?? []}
        onSelect={(selected) => {
          setPreset(selected);
          setShow(true);
        }}
      />
      <Card className="panel">
        {connections.data?.length ? (
          connections.data.map((connection) => (
            <div
              className="connection-row scroll-mt-6"
              id={`connection-${connection.id}`}
              key={connection.id}
            >
              <div className="row">
                <div className="item-icon">
                  <Plug size={20} />
                </div>
                <div className="grow">
                  <strong>{connection.name}</strong>
                  <small>
                    {connection.source === 'openapi' ? 'OpenAPI · ' : ''}
                    {connection.adapter} · {connection.transport} · {connection.mode}{' '}
                    {connection.transport === 'stdio'
                      ? `· ${connection.adapter === 'device' ? '所选设备执行' : '平台主机执行'} `
                      : ''}
                    {connection.url ? `· ${connection.url}` : ''}
                    {connection.protocolVersion ? ` · MCP ${connection.protocolVersion}` : ''}
                  </small>
                </div>
                <Status value={connection.status} />
              </div>
              <small>
                授权：{connection.identityMode === 'independent' ? '独立身份' : '连接账号'} ·
                活跃会话：{connection.sessions?.length ?? 0}
              </small>
              {connection.error ? <div className="error">{connection.error}</div> : null}
              <div className="row-actions">
                <Button variant="outline" onClick={() => setEditing(connection)}>
                  编辑
                </Button>
                {(
                  [
                    ['wake', '唤醒'],
                    ['sleep', '休眠'],
                    ['check', '健康检查'],
                  ] as const
                ).map(([operation, label]) => (
                  <Action
                    key={operation}
                    action={async () =>
                      setResult(
                        await api(`/connections/${connection.id}/${operation}`, { method: 'POST' }),
                      )
                    }
                  >
                    {label}
                  </Action>
                ))}
                <Action
                  action={async () =>
                    setResult({
                      sessions: connection.sessions,
                      bindings: await api(`/connections/${connection.id}/bindings`),
                    })
                  }
                >
                  会话与授权诊断
                </Action>
                <Action
                  action={async () =>
                    setResult(
                      await api(`/connections/${connection.id}/discover`, { method: 'POST' }),
                    )
                  }
                >
                  连接 / 刷新目录
                </Action>
                <Action
                  action={() => api(`/connections/${connection.id}/stop`, { method: 'POST' })}
                >
                  停止连接
                </Action>
                {connection.transport !== 'stdio' && connection.source !== 'openapi' ? (
                  <AuthorizationButton
                    endpoint={`/connections/${connection.id}/oauth`}
                    onResult={setResult}
                  />
                ) : null}
              </div>
              {connection.transport !== 'stdio' ? (
                <AuthorizationBindings
                  connectionId={connection.id}
                  source={connection.source ?? 'mcp'}
                />
              ) : null}
            </div>
          ))
        ) : (
          <Empty>还没有 MCP 连接，点击“添加连接”开始。</Empty>
        )}
      </Card>
      {result ? (
        <Card className="panel padded">
          <h2>操作结果</h2>
          <ConnectionResult result={result} />
        </Card>
      ) : null}
      <Dialog
        open={Boolean(editing)}
        onOpenChange={(open) => {
          if (!open) setEditing(undefined);
        }}
      >
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>编辑连接</DialogTitle>
            <DialogDescription>保存后结束现有运行会话，后续调用按新配置执行。</DialogDescription>
          </DialogHeader>
          {editing ? (
            <ConnectionSettings connection={editing} onSaved={() => setEditing(undefined)} />
          ) : null}
        </DialogContent>
      </Dialog>
      <OpenApiPanel />
      <ImportPanel devices={devices.data ?? []} />
    </>
  );
}
