import { AlertCircle } from 'lucide-react';
import { Link } from '@tanstack/react-router';
import { Button } from '../../components/ui/button.js';
import type { Connection } from '../../lib/api.js';
import { connectionNextStep } from './connectionHints.js';

export function ConnectionStatusMessage({
  connection,
  error,
  failureLabel,
  busy,
  onEdit,
  onRetry,
}: {
  connection: Connection;
  error?: string | null;
  failureLabel?: string;
  busy: boolean;
  onEdit: () => void;
  onRetry: () => void;
}) {
  if (connection.deviceOffline && connection.status !== 'stopped')
    return (
      <div role="alert" className="row-error mt-3 flex items-start gap-2 text-xs text-destructive">
        <AlertCircle size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
        <div className="min-w-0 flex-1 break-words">
          <p className="m-0 font-medium">设备离线，工具暂不可用</p>
          <p className="m-0 text-muted-foreground">
            这个连接运行在你的电脑上，那台电脑的连接器当前不在线。Agent
            暂时看不到它的工具，其它连接不受影响。
          </p>
          <p className="mt-1 text-muted-foreground">
            在那台电脑重新运行安装命令（「设备」页可复制）；连接器上线后会自动恢复。
          </p>
        </div>
        <div className="flex shrink-0 flex-col gap-2">
          <Button variant="outline" size="sm" render={<Link to="/devices" />}>
            查看设备
          </Button>
          <Button variant="outline" size="sm" disabled={busy} onClick={onRetry}>
            重试
          </Button>
        </div>
      </div>
    );
  return (
    <>
      {error ? (
        <div
          role="alert"
          className="row-error mt-3 flex items-start gap-2 text-xs text-destructive"
        >
          <AlertCircle size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
          <div className="min-w-0 flex-1 break-words">
            <p className="m-0 font-medium">
              {failureLabel
                ? `${failureLabel}未完成`
                : connection.status === 'waiting_authorization'
                  ? '等待账号授权'
                  : '连接失败'}
            </p>
            <p className="m-0 text-muted-foreground">{error}</p>
            <p className="mt-1 text-muted-foreground">{connectionNextStep(connection, error)}</p>
          </div>
          <div className="flex shrink-0 flex-col gap-2">
            <Button variant="outline" size="sm" disabled={busy} onClick={onEdit}>
              编辑连接
            </Button>
            <Button variant="outline" size="sm" disabled={busy} onClick={onRetry}>
              重试
            </Button>
          </div>
        </div>
      ) : null}
      {!error && connection.status !== 'connected' ? (
        <p role="status" className="mt-2 text-xs text-muted-foreground">
          {connection.status === 'waiting_authorization'
            ? '等待完成账号授权，尚未读取工具列表。'
            : connection.status === 'stopped'
              ? '连接已停止；可手动连接，读取工具列表。'
              : '连接配置已保存，尚未连接；点「连接」读取工具列表。'}
        </p>
      ) : null}
    </>
  );
}
