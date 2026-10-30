import { useState } from 'react';
import { connectorPresets } from '@platform/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Info, KeyRound, LoaderCircle, MoreHorizontal, RefreshCw, Settings2 } from 'lucide-react';
import { api, type Connection, type Device } from '../../lib/api.js';
import { InlineStatus, Status } from '../../components/shared/Controls.js';
import { Hint } from '../../components/ui/tooltip.js';
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
import { ConfirmDialog } from '../../components/shared/ConfirmDialog.js';
import { ConnectorIcon } from './ConnectorIcon.js';
import { executionLocation } from '../tools/toolCatalog.js';
import { ConnectionRecovery } from './ConnectionRecovery.js';
import { ConnectionStatusMessage } from './ConnectionStatusMessage.js';

type Operation = { label: string; action: () => Promise<unknown>; inspect?: boolean };
export type ConnectionInspection = { title: string; result: unknown };
/** Result of adding or authorizing a connection, shown on its own row. */
export type ConnectionNotice = { connectionId: string; message: string; error?: Error | null };

export function ConnectionItem({
  connection,
  devices,
  onEdit,
  onShare,
  onInspect,
  notice,
  onNoticeDone,
}: {
  notice?: ConnectionNotice;
  onNoticeDone?: () => void;
  connection: Connection;
  devices: ReadonlyMap<string, Device>;
  onEdit: (connection: Connection) => void;
  onShare: (connection: Connection) => void;
  onInspect: (inspection: ConnectionInspection) => void;
}) {
  const query = useQueryClient();
  const [busy, setBusy] = useState('');
  const [failure, setFailure] = useState<{ label: string; message: string }>();
  const [message, setMessage] = useState('');
  const [authorizationOpen, setAuthorizationOpen] = useState(false);
  const [stopping, setStopping] = useState(false);
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
      else setMessage(operation.label === '更新目录' ? '目录已更新' : `${operation.label}已完成`);
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
  const error = failure?.message ?? notice?.error?.message ?? connection.error;
  const needsAuthorization =
    supportsAuthorization &&
    (connection.status === 'waiting_authorization' || connection.status === 'error');
  const identity = publicService
    ? '无需账号授权'
    : connection.identityMode === 'independent'
      ? '按调用凭证隔离'
      : '连接账号';
  return (
    <section
      id={`connection-${connection.id}`}
      aria-label={connection.name}
      className="scroll-mt-6 border-b px-4 py-3 last:border-b-0 target:bg-muted/40"
    >
      <div className="flex flex-wrap items-center gap-3">
        <ConnectorIcon presetId={connection.presetId} />
        <div className="min-w-0 flex-1 basis-40">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-medium">{connection.name}</h3>
            <Status
              value={connection.deviceOffline ? 'error' : connection.status}
              label={
                connection.deviceOffline
                  ? '设备离线'
                  : connection.status === 'waiting_authorization'
                    ? '等待账号授权'
                    : undefined
              }
            />
            <Hint content={`${executionLocation(connection, devices)} · ${identity}`}>
              <span
                tabIndex={0}
                className="inline-flex text-subtle-foreground"
                aria-label={`执行位置：${executionLocation(connection, devices)}，${identity}`}
              >
                <Info size={14} aria-hidden="true" />
              </span>
            </Hint>
          </div>
          <p className="mt-1 truncate text-xs text-muted-foreground" title={connection.url}>
            {connection.url ?? `${connection.transport.toUpperCase()} · 本地进程`}
          </p>
        </div>
        <div
          className="flex items-center gap-2 max-sm:w-full max-sm:justify-end"
          aria-busy={Boolean(busy)}
        >
          {connected ? (
            <>
              <Button
                variant="outline"
                render={<Link to="/profiles" search={{ connectionId: connection.id }} />}
              >
                给 Agent 授权
              </Button>
              <Button
                variant="ghost"
                render={<Link to="/tools" search={{ connectionId: connection.id }} />}
              >
                查看工具
              </Button>
            </>
          ) : error ? null : (
            <Button
              variant="outline"
              disabled={Boolean(busy)}
              onClick={() => perform('discover', '更新目录')}
            >
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
          {needsAuthorization ? (
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
              {supportsAuthorization && !needsAuthorization ? (
                <DropdownMenuItem onClick={() => setAuthorizationOpen(true)}>
                  <KeyRound /> 授权与账号
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuItem onClick={() => onShare(connection)}>共享连接</DropdownMenuItem>
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
              <DropdownMenuItem variant="destructive" onClick={() => setStopping(true)}>
                停止连接
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      <ConnectionStatusMessage
        connection={connection}
        error={error}
        failureLabel={failure?.label}
        busy={Boolean(busy)}
        onEdit={() => onEdit(connection)}
        onRetry={() => perform('discover', '更新目录')}
      />
      {notice && !notice.error ? (
        <p className="mt-2 text-xs">
          <InlineStatus onDone={onNoticeDone}>{notice.message}</InlineStatus>
        </p>
      ) : notice?.error ? (
        <p role="status" className="mt-2 text-xs text-muted-foreground">
          {notice.message}
        </p>
      ) : null}
      <ConnectionRecovery connection={connection} />
      {busy ? (
        <p role="status" className="mt-2 text-xs text-muted-foreground">
          正在{busy}…
        </p>
      ) : message ? (
        <p className="mt-2 text-xs">
          <InlineStatus onDone={() => setMessage('')}>{message}</InlineStatus>
        </p>
      ) : null}
      <ConfirmDialog
        open={stopping}
        onOpenChange={setStopping}
        title={`停止「${connection.name}」？`}
        description="正在进行的调用会被中断。"
        confirmLabel="停止"
        danger
        onConfirm={() => {
          setStopping(false);
          perform('stop', '停止连接');
        }}
      />
      <Dialog open={authorizationOpen} onOpenChange={setAuthorizationOpen}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{connection.name} · 授权与账号</DialogTitle>
            <DialogDescription>
              OAuth 会跳转到供应商确认后返回；Token 和 API Key 在「编辑连接」中配置。
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
