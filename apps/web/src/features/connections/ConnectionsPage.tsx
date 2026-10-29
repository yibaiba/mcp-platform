import { BundlePanel } from '../bundles/BundlePanel.js';
import { ConnectionSettings } from './ConnectionSettings.js';
import { OpenApiPanel } from './OpenApiPanel.js';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { ConnectorPreset, ConnectorAuthentication } from '@platform/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
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
import { Empty, Feedback } from '../../components/shared/Controls.js';
import { ConnectionForm } from './ConnectionForm.js';
import { ImportPanel } from './ImportPanel.js';
import { ConnectorCatalog } from './ConnectorCatalog.js';
import { ConnectorForm } from './ConnectorForm.js';
import { ConnectionResult } from './ConnectionResult.js';
import { authorizeConnection } from './authorizationFlow.js';
import { authorizationResult } from './authorizationResult.js';
import { ConnectionItem, type ConnectionInspection } from './ConnectionItem.js';
import { SetupChecklist } from '../onboarding/SetupChecklist.js';
import { ConnectionShares } from './ConnectionShares.js';
import { IncomingShares } from './IncomingShares.js';

export default function ConnectionsPage() {
  const [editing, setEditing] = useState<Connection>();
  const [sharing, setSharing] = useState<Connection>();
  const [show, setShow] = useState(false);
  const [preset, setPreset] = useState<ConnectorPreset>();
  const [inspection, setInspection] = useState<ConnectionInspection>();
  const setResult = (result: unknown) => setInspection({ title: '连接设置结果', result });
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
    select: (rows) => rows.filter((row) => row.source !== 'library'),
    refetchInterval: (query) =>
      query.state.data?.some((connection) => connection.health?.recover) ? 5000 : false,
  });
  const devices = useQuery({ queryKey: ['devices'], queryFn: () => api<Device[]>('/devices') });
  const deviceById = new Map(devices.data?.map((device) => [device.id, device]));
  const connectorCatalog = (
    <ConnectorCatalog
      connections={connections.data ?? []}
      onSelect={(selected) => {
        setPreset(selected);
        setShow(true);
      }}
    />
  );
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
                  ? '选择服务运行方式和认证信息，保存后自动连接，再配置 Agent 权限。'
                  : '选择执行位置和连接协议，再填写服务地址或启动命令。'}
              </DialogDescription>
            </DialogHeader>
            {preset ? (
              <ConnectorForm key={preset.id} preset={preset} onSaved={connectCreated} />
            ) : (
              <ConnectionForm
                devices={devices.data ?? []}
                onSaved={() => {
                  setShow(false);
                  setSetupError(null);
                  setSetupMessage(
                    '配置已保存。点击新连接的“连接”读取工具目录；OAuth 服务请先打开“授权与账号”。',
                  );
                }}
              />
            )}
          </DialogContent>
        </Dialog>
      </div>
      <Feedback error={connections.error ?? devices.error} />
      {setupMessage ? <p role="status">{setupMessage}</p> : null}
      <Feedback error={setupError} />
      <SetupChecklist compact />
      {!connections.data?.length ? connectorCatalog : null}
      <Card className="panel">
        <div className="panel-heading">
          <div>
            <h2>我的连接</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              同一服务可添加多个账号。编辑、健康检查和运行控制在“更多操作”中。
            </p>
          </div>
          <span className="shrink-0 text-xs text-muted-foreground">
            {connections.data?.length ?? '—'} 个连接
          </span>
        </div>
        {connections.data?.length ? (
          connections.data.map((connection) => (
            <ConnectionItem
              key={connection.id}
              connection={connection}
              devices={deviceById}
              onShare={setSharing}
              onEdit={setEditing}
              onInspect={setInspection}
            />
          ))
        ) : connections.isPending ? (
          <p role="status" className="p-5 text-muted-foreground">
            正在读取连接…
          </p>
        ) : connections.isSuccess ? (
          <Empty>选择上方服务添加第一个账号，或使用“添加连接”填写自定义服务。</Empty>
        ) : null}
      </Card>
      {connections.data?.length ? connectorCatalog : null}
      <Dialog
        open={Boolean(inspection)}
        onOpenChange={(open) => {
          if (!open) setInspection(undefined);
        }}
      >
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{inspection?.title}</DialogTitle>
            <DialogDescription>
              此处显示本次操作的实际返回。详细数据可在诊断中展开。
            </DialogDescription>
          </DialogHeader>
          {inspection ? <ConnectionResult result={inspection.result} /> : null}
        </DialogContent>
      </Dialog>
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
      <IncomingShares devices={devices.data ?? []} />
      <BundlePanel devices={devices.data ?? []} connections={connections.data ?? []} />
      <OpenApiPanel />
      <Dialog
        open={Boolean(sharing)}
        onOpenChange={(open) => {
          if (!open) setSharing(undefined);
        }}
      >
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>共享 {sharing?.name}</DialogTitle>
            <DialogDescription>按接收账号授予能力，并明确选择凭证使用方式。</DialogDescription>
          </DialogHeader>
          {sharing && <ConnectionShares connectionId={sharing.id} />}
        </DialogContent>
      </Dialog>
      <ImportPanel devices={devices.data ?? []} />
    </>
  );
}
