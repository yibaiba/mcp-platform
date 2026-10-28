import { useState } from 'react';
import { connectorPresets } from '@platform/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  AlertCircle,
  KeyRound,
  LoaderCircle,
  MoreHorizontal,
  RefreshCw,
  Settings2,
} from 'lucide-react';
import { api, type Connection, type Device } from '../../lib/api.js';
import { Status } from '../../components/shared/Controls.js';
import { Button } from '../../components/ui/button.js';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../../components/ui/dropdown-menu.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog.js';
import { AuthorizationBindings } from './AuthorizationBindings.js';
import { ConnectorIcon } from './ConnectorIcon.js';
import { executionLocation } from '../tools/toolCatalog.js';
import { ConnectionRecovery } from './ConnectionRecovery.js';

type Operation = { label: string; action: () => Promise<unknown>; inspect?: boolean };
export type ConnectionInspection = { title: string; result: unknown };

export function ConnectionItem({
  connection,
  devices,
  onEdit,
  onInspect,
}: {
  connection: Connection;
  devices: ReadonlyMap<string, Device>;
  onEdit: (connection: Connection) => void;
  onInspect: (inspection: ConnectionInspection) => void;
}) {
  const query = useQueryClient();
  const [busy, setBusy] = useState('');
  const [failure, setFailure] = useState<{ label: string; message: string }>();
  const [message, setMessage] = useState('');
  const [authorizationOpen, setAuthorizationOpen] = useState(false);
  const connected = connection.status === 'connected';
  const preset = connectorPresets.find((preset) => preset.id === connection.presetId);
  const publicService = preset?.authentication.length === 1 && preset.authentication[0] === 'none';
  const supportsAuthorization = connection.transport !== 'stdio' && !publicService;
  const root = `/connections/${connection.id}`;
  async function run(operation: Operation) {
    setBusy(operation.label);
    setFailure(undefined);
    setMessage('');
    try {
      const result = await operation.action();
      if (operation.inspect)
        onInspect({ title: `${connection.name} · ${operation.label}`, result });
      else
        setMessage(
          operation.label === '更新目录'
            ? '目录已更新，可查看工具或分配给 Agent。'
            : `${operation.label}已完成。`,
        );
    } catch (error) {
      setFailure({
        label: operation.label,
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      await query.invalidateQueries();
      setBusy('');
    }
  }
  const perform = (operation: string, label: string, inspect = false) =>
    void run({
      label,
      inspect,
      action: () => api(`${root}/${operation}`, { method: 'POST' }),
    });
  const error = failure?.message ?? connection.error;
  return (
    <section
      id={`connection-${connection.id}`}
      aria-label={connection.name}
      className="scroll-mt-6 border-b px-5 py-5 last:border-b-0 target:bg-muted/40"
    >
      <div className="flex flex-wrap items-center gap-3">
        <ConnectorIcon presetId={connection.presetId} />
        <div className="min-w-0 flex-1 basis-40">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-medium">{connection.name}</h3>
            <Status value={connection.status} />
          </div>
          <p className="mt-1 truncate text-xs text-muted-foreground" title={connection.url}>
            {connection.url ?? `${connection.transport.toUpperCase()} · 本地进程`}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {executionLocation(connection, devices)} ·{' '}
            {publicService
              ? '无需账号授权'
              : connection.identityMode === 'independent'
                ? '按调用凭证隔离'
                : '连接账号'}
          </p>
        </div>
        <div
          className="flex items-center gap-2 max-sm:w-full max-sm:justify-end"
          aria-busy={Boolean(busy)}
        >
          {connected ? (
            <Button
              variant="outline"
              render={<Link to="/tools" search={{ connectionId: connection.id }} />}
            >
              查看工具
            </Button>
          ) : (
            <Button disabled={Boolean(busy)} onClick={() => perform('discover', '更新目录')}>
              {busy ? (
                <LoaderCircle
                  className="animate-spin motion-reduce:animate-none"
                  aria-hidden="true"
                />
              ) : (
                <RefreshCw aria-hidden="true" />
              )}
              {busy || '连接'}
            </Button>
          )}
          {supportsAuthorization ? (
            <Button
              variant="ghost"
              disabled={Boolean(busy)}
              onClick={() => setAuthorizationOpen(true)}
            >
              <KeyRound aria-hidden="true" /> 授权与账号
            </Button>
          ) : null}
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-10 max-sm:size-11"
                  disabled={Boolean(busy)}
                />
              }
              aria-label={`${connection.name} 更多操作`}
            >
              <MoreHorizontal aria-hidden="true" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-48">
              <DropdownMenuItem onClick={() => onEdit(connection)}>
                <Settings2 /> 编辑连接
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => perform('discover', '更新目录')}>
                刷新工具目录
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => perform('check', '健康检查', true)}>
                健康检查
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() =>
                  void run({
                    label: '会话与授权诊断',
                    inspect: true,
                    action: async () => ({
                      adapter: connection.adapter,
                      transport: connection.transport,
                      mode: connection.mode,
                      protocolVersion: connection.protocolVersion,
                      sessions: connection.sessions,
                      bindings: await api(`${root}/bindings`),
                    }),
                  })
                }
              >
                会话与授权诊断
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => perform('wake', '唤醒连接')}>
                唤醒连接
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => perform('sleep', '休眠连接')}>
                休眠连接
              </DropdownMenuItem>
              <DropdownMenuItem variant="destructive" onClick={() => perform('stop', '停止连接')}>
                停止连接
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      {error ? (
        <div
          role="alert"
          className="mt-4 flex gap-2 rounded-md border border-destructive/20 bg-destructive/5 p-3 text-xs text-destructive"
        >
          <AlertCircle size={16} className="shrink-0" aria-hidden="true" />
          <div className="min-w-0 space-y-1 break-words">
            <p className="font-medium">{failure ? `${failure.label}未完成` : '连接需要处理'}</p>
            <p>{error}</p>
            <p className="text-muted-foreground">
              检查服务地址与运行状态；需要登录的服务请打开“授权与账号”。
            </p>
          </div>
        </div>
      ) : null}
      <ConnectionRecovery connection={connection} />
      {busy || message ? (
        <p role="status" className="mt-3 text-xs text-muted-foreground">
          {busy ? `正在${busy}…` : message}
        </p>
      ) : null}
      {connected ? (
        <p className="mt-3 text-xs text-muted-foreground">
          下一步：
          <Link
            to="/profiles"
            hash="create-profile"
            className="text-primary underline-offset-4 hover:underline"
          >
            为 Agent 选择可用工具
          </Link>
          ，再复制客户端接入配置。
        </p>
      ) : null}
      <Dialog open={authorizationOpen} onOpenChange={setAuthorizationOpen}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{connection.name} · 授权与账号</DialogTitle>
            <DialogDescription>
              OAuth 服务会跳转到供应商确认，完成后自动返回。Token 和 API Key 在“编辑连接”中配置。
            </DialogDescription>
          </DialogHeader>
          <AuthorizationBindings
            connectionId={connection.id}
            source={connection.source ?? 'mcp'}
            defaultOpen
          />
        </DialogContent>
      </Dialog>
    </section>
  );
}
