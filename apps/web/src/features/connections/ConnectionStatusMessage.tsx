import { AlertCircle } from 'lucide-react';
import { Button } from '../../components/ui/button.js';
import type { Connection } from '../../lib/api.js';

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
            <p className="mt-1 text-muted-foreground">
              {connection.status === 'waiting_authorization'
                ? '打开“授权与账号”完成授权，再连接读取工具目录。'
                : '检查服务地址、网络和凭据；修改配置后可手动重试连接。'}
            </p>
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
            ? '等待完成账号授权，尚未读取工具目录。'
            : connection.status === 'stopped'
              ? '连接已停止；可手动连接，读取工具目录。'
              : '连接配置已保存，连接成功后可为 Agent 分配工具权限。'}
        </p>
      ) : null}
    </>
  );
}
