import {
  useId,
  cloneElement,
  isValidElement,
  useState,
  type ReactNode,
  type FormEvent,
} from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ConfirmDialog, type Confirmation } from './ConfirmDialog.js';
import { Button } from '../ui/button.js';
import { Badge } from '../ui/badge.js';
import { Field as FieldContainer, FieldLabel, FieldDescription } from '../ui/field.js';
export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  const id = useId();
  const descriptionId = hint ? `${id}-hint` : undefined;
  const control = isValidElement<{ id?: string; 'aria-describedby'?: string }>(children)
    ? cloneElement(children, { id, 'aria-describedby': descriptionId })
    : children;
  return (
    <FieldContainer className="field">
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      {control}
      {hint ? <FieldDescription id={descriptionId}>{hint}</FieldDescription> : null}
    </FieldContainer>
  );
}
export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}
export function Feedback({ error }: { error: Error | null }) {
  return error ? (
    <div className="error" role="alert">
      {error.message}
    </div>
  ) : null;
}
export function Status({ value }: { value: string }) {
  const labels: Record<string, string> = {
    connected: '已连接',
    disconnected: '待连接',
    stopped: '已停止',
    error: '连接错误',
    succeeded: '成功',
    failed: '失败',
    unknown: '结果未知',
    running: '执行中',
    tool_error: '工具返回错误',
    online: '在线',
    offline: '离线',
    cancelled: '已取消',
    revoked: '已撤销',
    pairing_required: '待重新配对',
    installed: '已安装',
    waiting: '等待上游交互',
    waiting_authorization: '等待平台授权',
    pending: '待审批',
    approved: '已批准',
    rejected: '已拒绝',
    expired: '已到期',
    invalidated: '配置或身份已改变',
    interrupted: '进程重启已中断',
    queued: '待执行',
    created: '已保存',
    executing: '执行中',
    exported: '外部任务包已就绪',
  };
  return (
    <Badge variant="outline" className={`status status-${value}`}>
      <i aria-hidden="true" />
      {labels[value] ?? value}
    </Badge>
  );
}
export function Action({
  children,
  action,
  danger = false,
  confirmation,
}: {
  children: ReactNode;
  action: () => Promise<unknown>;
  danger?: boolean;
  confirmation?: Confirmation;
}) {
  const [confirming, setConfirming] = useState(false);
  const query = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  async function run() {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (error) {
      setError(error instanceof Error ? error : new Error(String(error)));
    } finally {
      // Failed connection attempts also persist a new diagnostic status.
      await query.invalidateQueries();
      setBusy(false);
    }
  }
  return (
    <span className="action">
      <Button
        variant={danger ? 'destructive' : 'outline'}
        disabled={busy}
        type="button"
        onClick={() => (confirmation ? setConfirming(true) : void run())}
      >
        {busy ? '处理中…' : children}
      </Button>
      <Feedback error={error} />
      {confirmation ? (
        <ConfirmDialog
          {...confirmation}
          open={confirming}
          onOpenChange={setConfirming}
          onConfirm={() => {
            setConfirming(false);
            void run();
          }}
          danger={danger}
        />
      ) : null}
    </span>
  );
}
type FormFeedback = { version: number | undefined; outcome: 'success' | Error };
export function Form({
  children,
  submit,
  label = '保存',
  noValidate = false,
  feedbackVersion,
}: {
  children: ReactNode;
  submit: (data: FormData) => Promise<unknown>;
  label?: string;
  noValidate?: boolean;
  feedbackVersion?: number;
}) {
  const query = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<FormFeedback>();
  // Async handlers retain the submitted version; edits invalidate their later feedback.
  const outcome = feedback?.version === feedbackVersion ? feedback?.outcome : undefined;
  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setBusy(true);
    setFeedback(undefined);
    try {
      await submit(data);
      await query.invalidateQueries();
      setFeedback({ version: feedbackVersion, outcome: 'success' });
    } catch (error) {
      setFeedback({
        version: feedbackVersion,
        outcome: error instanceof Error ? error : new Error(String(error)),
      });
    } finally {
      setBusy(false);
    }
  }
  return (
    <form
      onSubmit={(e) => void onSubmit(e)}
      onChange={() => setFeedback(undefined)}
      className="form"
      noValidate={noValidate}
    >
      <fieldset disabled={busy} className="form-fields">
        {children}
      </fieldset>
      <Feedback error={outcome instanceof Error ? outcome : null} />
      <div className="form-footer">
        <Button type="submit" disabled={busy}>
          {busy ? '处理中…' : label}
        </Button>
        {outcome === 'success' ? <span role="status">操作已完成</span> : null}
      </div>
    </form>
  );
}
export const value = (data: FormData, key: string) => String(data.get(key) ?? '');
export const date = (input: string | null) =>
  input ? new Date(input).toLocaleString('zh-CN') : '尚无记录';
export function Code({ value }: { value: unknown }) {
  return (
    <pre className="code">{typeof value === 'string' ? value : JSON.stringify(value, null, 2)}</pre>
  );
}
