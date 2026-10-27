import { ConnectionSettings } from './ConnectionSettings.js';
import { OpenApiPanel } from './OpenApiPanel.js';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
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
import { Action, Code, Empty, Feedback, Status } from '../../components/shared/Controls.js';
import { ConnectionForm } from './ConnectionForm.js';
import { ImportPanel } from './ImportPanel.js';
import { AuthorizationBindings } from './AuthorizationBindings.js';

export default function ConnectionsPage() {
  const [editing, setEditing] = useState<Connection>();
  const [show, setShow] = useState(false);
  const [result, setResult] = useState<unknown>();
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
          <DialogTrigger render={<Button />}>
            <Plus size={17} />
            添加连接
          </DialogTrigger>
          <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
            <DialogHeader>
              <DialogTitle>新建 MCP 连接</DialogTitle>
              <DialogDescription>
                选择执行位置和连接协议，再填写服务地址或启动命令。
              </DialogDescription>
            </DialogHeader>
            <ConnectionForm
              devices={devices.data ?? []}
              onSaved={(created) => {
                setResult(created);
                setShow(false);
              }}
            />
          </DialogContent>
        </Dialog>
      </div>
      <Feedback error={connections.error ?? devices.error} />
      <Card className="panel">
        {connections.data?.length ? (
          connections.data.map((connection) => (
            <div className="connection-row" key={connection.id}>
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
                  <Action
                    action={async () =>
                      setResult(
                        await api(`/connections/${connection.id}/oauth/start`, { method: 'POST' }),
                      )
                    }
                  >
                    发起授权
                  </Action>
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
          <Code value={result} />
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
